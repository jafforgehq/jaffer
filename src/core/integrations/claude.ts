import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../shared/util';

/**
 * Connecting Claude Code to Jaffer: its hooks (`jaffer hook <event>` in `~/.claude/settings.json`), which tell the companion, the
 * notification and the cost figure what the `claude` in Jaffer's terminal is doing. Every entry Jaffer adds is tagged so it can be
 * removed cleanly without touching the user's own hooks.
 */

const MARK = 'jaffer-managed';

export interface ClaudeStatus {
  claudeInstalled: boolean;
  claudePath?: string;
  hooks: boolean;
  settingsFile: string;
  error?: string;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; timeout?: number; [k: string]: unknown }[];
  [k: string]: unknown;
}

/**
 * Every event only reports Claude's live state (the companion, the notification, the cost figure) and is `async`, so it can never
 * slow Claude Code down, and prints nothing.
 */
const EVENTS: { event: string; arg: string }[] = [
  { event: 'SessionStart', arg: 'hook session-start' },
  { event: 'Stop', arg: 'hook stop' },
  { event: 'UserPromptSubmit', arg: 'hook user-prompt-submit' },
  { event: 'PreToolUse', arg: 'hook pre-tool-use' },
  { event: 'PostToolUse', arg: 'hook post-tool-use' },
  { event: 'PostToolUseFailure', arg: 'hook post-tool-use-failure' },
  { event: 'SubagentStart', arg: 'hook subagent-start' },
  { event: 'SubagentStop', arg: 'hook subagent-stop' },
  { event: 'Notification', arg: 'hook notification' },
  { event: 'SessionEnd', arg: 'hook session-end' },
];

/** How long Claude Code lets one of them run (it does not wait for them: they are `async`). */
const HOOK_TIMEOUT = 5;

/** The hooks run for every Claude Code on the machine: this keeps them from starting the Jaffer binary at all outside a Jaffer session. */
const GUARD = '[ "$JAFFER_SESSION" = 1 ] || exit 0; ';

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
    rest.push({ hooks: [{ type: 'command', command: `${GUARD}${shellQuote(cliPath)} ${ev.arg} # ${MARK}`, timeout: HOOK_TIMEOUT, async: true }] });
    data.hooks[ev.event] = rest;
  }
  if (JSON.stringify(data) === before) return { changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o644, { preserve: true });
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
  if (changed) writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', 0o644, { preserve: true });
  return { changed };
}

/**
 * True if Jaffer's hooks exist and every one of them already runs `cliPath`. A daemon started with another Jaffer home
 * (a release smoke test, a dev build) must not re-point the user's real hooks at its own, temporary wrapper.
 */
export function hooksPointAt(cliPath: string, home: string = os.homedir()): boolean {
  const { data, ok } = readSettings(settingsPath(home));
  if (!ok || !data.hooks || typeof data.hooks !== 'object') return false;
  const ours = Object.values(data.hooks).flatMap((list) => (Array.isArray(list) ? (list as HookEntry[]) : [])).filter(isOurs);
  const quoted = shellQuote(cliPath);
  return ours.length > 0 && ours.every((h) => h.hooks.filter((x) => typeof x.command === 'string' && x.command.includes(`# ${MARK}`)).every((x) => x.command.includes(quoted)));
}

export function hooksInstalled(home: string = os.homedir()): boolean {
  const { data, ok } = readSettings(settingsPath(home));
  if (!ok || !data.hooks) return false;
  return EVENTS.every((ev) => (Array.isArray(data.hooks[ev.event]) ? data.hooks[ev.event] : []).some(isOurs));
}

// ------------------------------------------------------------------ the claude CLI

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

/**
 * Takes back the MCP server (`jaffer`, user scope) that Jaffer's memory registered with Claude Code before 0.6.0: Reset and the first
 * start of an upgraded Mac run it once. Nothing registers one any more. `ok` is false when there was none (or `claude` failed).
 */
export async function removeMcp(claude: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string }> {
  // (`claude`'s own folder first on its PATH: a `claude` installed with npm is a script that starts the `node` next to it, and an app
  // opened from the Finder has a short PATH)
  const r = await run(claude, ['mcp', 'remove', 'jaffer', '-s', 'user'], { ...env, PATH: [path.dirname(claude), env.PATH].filter(Boolean).join(path.delimiter) }, 15_000);
  return { ok: r.code === 0, message: r.out.trim() };
}

export async function claudeStatus(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<ClaudeStatus> {
  const claude = await findClaude(env);
  return { claudeInstalled: !!claude, claudePath: claude ?? undefined, hooks: hooksInstalled(home), settingsFile: settingsPath(home) };
}

/** Connects Claude Code: installs (or refreshes) Jaffer's hooks, and nothing else. */
export async function setupClaude(cliPath: string, opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ status: ClaudeStatus; messages: string[] }> {
  const home = opts.home ?? os.homedir();
  const h = installHooks(cliPath, home);
  const messages = [h.error ? `Hooks: ${h.error}` : h.changed ? 'Installed Jaffer’s hooks in ~/.claude/settings.json.' : 'Hooks already installed.'];
  return { status: await claudeStatus(home, opts.env ?? process.env), messages };
}

/** Disconnects Claude Code: removes Jaffer's hooks (the person's own stay). */
export async function teardownClaude(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<{ status: ClaudeStatus; messages: string[] }> {
  const h = removeHooks(home);
  const messages = [h.error ? `Hooks: ${h.error}` : h.changed ? 'Removed Jaffer hooks.' : 'No Jaffer hooks were installed.'];
  return { status: await claudeStatus(home, env), messages };
}
