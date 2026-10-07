import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../shared/util';

/**
 * One-step wiring of Claude Code to Jaffer's memory:
 *   - an MCP server (`jaffer mcp`) so Claude can recall/remember on demand
 *   - SessionStart hook: every Claude Code session (including after /compact) starts with the
 *     memory relevant to the project it was launched in
 *   - Stop hook: tell Jaffer a turn finished so it learns from it immediately
 * Everything Jaffer adds is tagged so it can be removed cleanly without touching the user's own hooks.
 */

const MARK = 'jaffer-managed';

export interface ClaudeStatus {
  claudeInstalled: boolean;
  claudePath?: string;
  hooks: boolean;
  mcp: boolean;
  settingsFile: string;
  error?: string;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number; [k: string]: unknown }[];
  [k: string]: unknown;
}

/**
 * SessionStart and Stop feed memory, so Claude Code waits for them. Every other event only reports to the live
 * companion panel and is `async`, so it can never slow Claude Code down.
 */
const EVENTS: { event: string; arg: string; timeout: number; async?: boolean }[] = [
  { event: 'SessionStart', arg: 'hook session-start', timeout: 8 },
  { event: 'Stop', arg: 'hook stop', timeout: 5 },
  { event: 'UserPromptSubmit', arg: 'hook user-prompt-submit', timeout: 5, async: true },
  { event: 'PreToolUse', arg: 'hook pre-tool-use', timeout: 5, async: true },
  { event: 'PostToolUse', arg: 'hook post-tool-use', timeout: 5, async: true },
  { event: 'PostToolUseFailure', arg: 'hook post-tool-use-failure', timeout: 5, async: true },
  { event: 'SubagentStart', arg: 'hook subagent-start', timeout: 5, async: true },
  { event: 'SubagentStop', arg: 'hook subagent-stop', timeout: 5, async: true },
  { event: 'Notification', arg: 'hook notification', timeout: 5, async: true },
  { event: 'SessionEnd', arg: 'hook session-end', timeout: 5, async: true },
];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function settingsPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

function readSettings(file: string): { data: Record<string, any>; ok: boolean; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { data: {}, ok: true };
  }
  if (!raw.trim()) return { data: {}, ok: true };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data, ok: true };
    return { data: {}, ok: false, error: 'settings.json is not a JSON object' };
  } catch (e) {
    return { data: {}, ok: false, error: `settings.json is not valid JSON (${e instanceof Error ? e.message : e}); leaving it untouched` };
  }
}

function isOurs(h: HookEntry): boolean {
  return h.hooks?.some((x) => typeof x.command === 'string' && x.command.includes(`# ${MARK}`));
}

/** Add (or refresh) Jaffer's hooks in ~/.claude/settings.json, preserving everything else. */
export function installHooks(cliPath: string, home: string = os.homedir()): { changed: boolean; error?: string } {
  const file = settingsPath(home);
  const { data, ok, error } = readSettings(file);
  if (!ok) return { changed: false, error };
  const before = JSON.stringify(data);
  data.hooks ??= {};
  for (const ev of EVENTS) {
    const list: HookEntry[] = Array.isArray(data.hooks[ev.event]) ? data.hooks[ev.event] : [];
    const rest = list.filter((h) => !isOurs(h));
    rest.push({ hooks: [{ type: 'command', command: `${shellQuote(cliPath)} ${ev.arg} # ${MARK}`, timeout: ev.timeout, ...(ev.async ? { async: true } : {}) }] });
    data.hooks[ev.event] = rest;
  }
  if (JSON.stringify(data) === before) return { changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o644);
  return { changed: true };
}

export function removeHooks(home: string = os.homedir()): { changed: boolean; error?: string } {
  const file = settingsPath(home);
  const { data, ok, error } = readSettings(file);
  if (!ok) return { changed: false, error };
  if (!data.hooks) return { changed: false };
  let changed = false;
  for (const ev of EVENTS) {
    const list: HookEntry[] = Array.isArray(data.hooks[ev.event]) ? data.hooks[ev.event] : [];
    const rest = list.filter((h) => !isOurs(h));
    if (rest.length !== list.length) {
      changed = true;
      if (rest.length) data.hooks[ev.event] = rest;
      else delete data.hooks[ev.event];
    }
  }
  if (data.hooks && Object.keys(data.hooks).length === 0) delete data.hooks;
  if (changed) writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o644);
  return { changed };
}

/** True if Jaffer has any hook in the user's Claude Code settings, even an older install that lacks the newest events. */
export function hooksConnected(home: string = os.homedir()): boolean {
  const { data, ok } = readSettings(settingsPath(home));
  if (!ok || !data.hooks || typeof data.hooks !== 'object') return false;
  return Object.values(data.hooks).some((list) => Array.isArray(list) && (list as HookEntry[]).some(isOurs));
}

export function hooksInstalled(home: string = os.homedir()): boolean {
  const { data, ok } = readSettings(settingsPath(home));
  if (!ok || !data.hooks) return false;
  return EVENTS.every((ev) => (Array.isArray(data.hooks[ev.event]) ? data.hooks[ev.event] : []).some(isOurs));
}

// ------------------------------------------------------------------ claude CLI (MCP registration)

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

/** Locate `claude` the way the user's own shell would (the daemon may have a minimal PATH). */
export async function findClaude(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  // PATH first, in order (the first hit is the one the user's shell runs), then the usual install locations.
  const candidates = [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'claude')),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : '/bin/zsh';
  if (fs.existsSync(shell)) {
    const r = await run(shell, ['-lic', 'command -v claude'], env, 8000);
    const line = r.out.trim().split('\n').pop()?.trim();
    if (r.code === 0 && line && line.startsWith('/')) return line;
  }
  return null;
}

export async function mcpInstalled(claude: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const r = await run(claude, ['mcp', 'get', 'jaffer'], env, 15_000);
  return r.code === 0 && /jaffer/i.test(r.out);
}

export async function installMcp(claude: string, cliPath: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string }> {
  await run(claude, ['mcp', 'remove', 'jaffer', '-s', 'user'], env, 15_000); // refresh if present
  const json = JSON.stringify({ type: 'stdio', command: cliPath, args: ['mcp'] });
  const r = await run(claude, ['mcp', 'add-json', '--scope', 'user', 'jaffer', json], env, 20_000);
  return { ok: r.code === 0, message: r.out.trim() };
}

export async function removeMcp(claude: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string }> {
  const r = await run(claude, ['mcp', 'remove', 'jaffer', '-s', 'user'], env, 15_000);
  return { ok: r.code === 0, message: r.out.trim() };
}

export async function claudeStatus(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<ClaudeStatus> {
  const claude = await findClaude(env);
  return { claudeInstalled: !!claude, claudePath: claude ?? undefined, hooks: hooksInstalled(home), mcp: claude ? await mcpInstalled(claude, env) : false, settingsFile: settingsPath(home) };
}

export async function setupClaude(cliPath: string, opts: { home?: string; env?: NodeJS.ProcessEnv; mcp?: boolean; hooks?: boolean } = {}): Promise<{ status: ClaudeStatus; messages: string[] }> {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const messages: string[] = [];
  if (opts.hooks !== false) {
    const h = installHooks(cliPath, home);
    messages.push(h.error ? `Hooks: ${h.error}` : h.changed ? 'Installed SessionStart/Stop hooks in ~/.claude/settings.json.' : 'Hooks already installed.');
  }
  if (opts.mcp !== false) {
    const claude = await findClaude(env);
    if (!claude) messages.push('MCP: `claude` was not found on PATH, so the MCP server was not registered.');
    else {
      const m = await installMcp(claude, cliPath, env);
      messages.push(m.ok ? 'Registered the Jaffer MCP server with Claude Code (user scope).' : `MCP: ${m.message || 'claude mcp add failed'}`);
    }
  }
  return { status: await claudeStatus(home, env), messages };
}

export async function teardownClaude(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<{ status: ClaudeStatus; messages: string[] }> {
  const messages: string[] = [];
  const h = removeHooks(home);
  messages.push(h.error ? `Hooks: ${h.error}` : h.changed ? 'Removed Jaffer hooks.' : 'No Jaffer hooks were installed.');
  const claude = await findClaude(env);
  if (claude) {
    const m = await removeMcp(claude, env);
    messages.push(m.ok ? 'Removed the MCP server registration.' : 'MCP server was not registered.');
  }
  return { status: await claudeStatus(home, env), messages };
}
