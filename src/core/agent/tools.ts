import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { RunResult } from '../session/terminal';
import { RunRefused } from '../session/terminal';
import type { ToolSpec } from './types';
import { truncate } from '../../shared/util';
import { redactText } from '../../shared/redact';

/** What the tools need from the rest of the system. Keeps the tools testable without a PTY. */
export interface ToolEnv {
  cwd(): string;
  runInSession(cmd: string, timeoutMs: number): Promise<RunResult>;
  readScreen(lines: number): string;
  terminalState(): { busy: string | null; alt: boolean; cwd: string };
  typeIntoTerminal(text: string): void;
  recall(query: string): string;
  remember(text: string, kind?: string, scope?: 'global' | 'project'): string;
  forget(idOrQuery: string): string;
  projectRoot(): string | undefined;
  runIn: 'session' | 'subprocess';
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT = 20_000;

function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`"${name}" must be a string`);
  return v;
}
function optNum(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
}

export function resolvePath(p: string, cwd: string): string {
  const expanded = p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(cwd, expanded);
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'run_command',
    description:
      "Run a shell command in the user's live terminal session and return its output and exit code. The command is typed into their shell, so it is visible to them and shares their working directory, environment variables and activated tools. Use for building, testing, git, package managers, inspecting the system. Do not use for long-running servers or interactive programs (use a short timeout and read_terminal instead).",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeout_seconds: { type: 'number', description: 'Give up waiting after this many seconds (default 120, max 900). The command keeps running in the terminal.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_terminal',
    description: "Read what is currently on the user's terminal screen (last N lines) and whether a program is running. Use to observe a dev server, another agent, or an interactive program without interrupting it.",
    input_schema: { type: 'object', properties: { lines: { type: 'number', description: 'How many lines (default 40, max 200).' } }, required: [] },
  },
  {
    name: 'terminal_input',
    description: "Type text into the program currently running in the user's terminal (e.g. answer a prompt). Only use when the user asked you to drive that program. Set enter=true to press Return after the text. Special: pass text '\\u0003' for Ctrl-C.",
    input_schema: { type: 'object', properties: { text: { type: 'string' }, enter: { type: 'boolean' } }, required: ['text'] },
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines. Use offset/limit for large files.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: '1-based first line (default 1).' }, limit: { type: 'number', description: 'Max lines (default 400, max 2000).' } }, required: ['path'] },
  },
  {
    name: 'list_dir',
    description: 'List a directory (names, with / for directories). depth defaults to 1; max 4. Skips node_modules, .git and other bulky folders.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } }, required: [] },
  },
  {
    name: 'search_files',
    description: 'Search file contents with a regular expression (ripgrep when available). Returns file:line:text matches.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory or file (default: current directory).' }, glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts".' } }, required: ['pattern'] },
  },
  {
    name: 'write_file',
    description: 'Create a file or fully replace its contents. Creates parent directories. Prefer edit_file for changes to existing files.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must match exactly once (include enough context), unless replace_all is true.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] },
  },
  {
    name: 'recall',
    description: "Search Jaffer's long-term memory of the user (preferences, project conventions, lessons, learned procedures).",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'remember',
    description: "Save something durable to long-term memory: a preference, a convention of the current project, a lesson from a non-obvious fix. One self-contained sentence. Never store secrets or transient task details.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'convention', 'fact', 'workflow', 'lesson'] },
        scope: { type: 'string', enum: ['global', 'project'], description: "'project' ties it to the current project; default 'global'." },
      },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a memory (by id from recall, or by describing it) when it is wrong, outdated, or the user asks you to forget it.',
    input_schema: { type: 'object', properties: { id_or_description: { type: 'string' } }, required: ['id_or_description'] },
  },
];

/** A path as people say it: `~/code/app/src/a.ts`, and when still long, its tail (the file name matters most). */
export function shortPath(p: string, home: string = os.homedir()): string {
  let out = p;
  if (home && home !== '/' && (out === home || out.startsWith(home + path.sep))) out = '~' + out.slice(home.length);
  if (out.length > 56) {
    const parts = out.split(path.sep).filter(Boolean);
    if (parts.length > 3) out = '…/' + parts.slice(-3).join('/');
  }
  return out;
}

export function toolSummary(name: string, input: any): string {
  switch (name) {
    case 'run_command':
      return String(input?.command ?? '');
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return shortPath(String(input?.path ?? ''));
    case 'list_dir':
      return shortPath(String(input?.path ?? '.'));
    case 'search_files':
      return `${input?.pattern ?? ''}${input?.path ? ` in ${shortPath(String(input.path))}` : ''}`;
    case 'terminal_input':
      return JSON.stringify(String(input?.text ?? '')).slice(0, 80);
    case 'recall':
      return String(input?.query ?? '');
    case 'remember':
      return String(input?.text ?? '');
    case 'forget':
      return String(input?.id_or_description ?? '');
    default:
      return '';
  }
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

function ok(output: string): ToolOutcome {
  return { output: truncateMiddle(output, MAX_OUTPUT), isError: false };
}
function fail(output: string): ToolOutcome {
  return { output, isError: true };
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tailLen = max - head - 40;
  return `${s.slice(0, head)}\n… [${s.length - head - tailLen} characters omitted] …\n${s.slice(s.length - tailLen)}`;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.cache', 'Pods', 'DerivedData', '.gradle', '.idea', '.turbo', 'coverage']);

export async function executeTool(env: ToolEnv, name: string, input: any, signal?: AbortSignal): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'run_command':
        return await runCommand(env, str(input?.command, 'command'), optNum(input?.timeout_seconds, 120, 1, 900) * 1000, signal);
      case 'read_terminal': {
        const lines = optNum(input?.lines, 40, 1, 200);
        const st = env.terminalState();
        const screen = env.readScreen(lines);
        return ok(`[cwd: ${st.cwd}${st.busy ? `, running: ${st.busy}` : ', idle at prompt'}${st.alt ? ', full-screen program active' : ''}]\n${redactText(screen) || '(screen is empty)'}`);
      }
      case 'terminal_input': {
        const text = str(input?.text, 'text');
        env.typeIntoTerminal(text + (input?.enter ? '\r' : ''));
        return ok('Sent to the terminal.');
      }
      case 'read_file':
        return readFile(env, str(input?.path, 'path'), optNum(input?.offset, 1, 1, 1e9), optNum(input?.limit, 400, 1, 2000));
      case 'list_dir':
        return listDir(env, typeof input?.path === 'string' ? input.path : '.', optNum(input?.depth, 1, 1, 4));
      case 'search_files':
        return await searchFiles(env, str(input?.pattern, 'pattern'), typeof input?.path === 'string' ? input.path : '.', typeof input?.glob === 'string' ? input.glob : undefined, signal);
      case 'write_file':
        return writeFile(env, str(input?.path, 'path'), str(input?.content, 'content'));
      case 'edit_file':
        return editFile(env, str(input?.path, 'path'), str(input?.old_string, 'old_string'), str(input?.new_string, 'new_string'), input?.replace_all === true);
      case 'recall':
        return ok(env.recall(str(input?.query, 'query')));
      case 'remember':
        return ok(env.remember(str(input?.text, 'text'), typeof input?.kind === 'string' ? input.kind : undefined, input?.scope === 'project' ? 'project' : 'global'));
      case 'forget':
        return ok(env.forget(str(input?.id_or_description, 'id_or_description')));
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function runCommand(env: ToolEnv, command: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolOutcome> {
  if (env.runIn === 'session') {
    try {
      const r = await env.runInSession(command, timeoutMs);
      return formatRun(r.output, r.exit, r.timedOut, r.durMs);
    } catch (e) {
      if (!(e instanceof RunRefused)) throw e;
      if (e.reason === 'busy') return fail(`${e.message} Use read_terminal to see what is running, or wait and try again. (I will not interrupt it.)`);
      // no integration / exited: fall through to an isolated subprocess
    }
  }
  const r = await runSubprocess(command, env.cwd(), timeoutMs, signal);
  return formatRun(r.output, r.exit, r.timedOut, r.durMs);
}

function formatRun(output: string, exit: number | null, timedOut: boolean, durMs: number): ToolOutcome {
  const out = redactText(output).trim();
  if (timedOut) return ok(`${out ? out + '\n\n' : ''}[still running after ${(durMs / 1000).toFixed(0)}s — left running in the terminal. Use read_terminal to check on it.]`);
  const head = exit === 0 || exit === null ? '' : `[exit code ${exit}]\n`;
  return { output: truncateMiddle(`${head}${out || '(no output)'}`, MAX_OUTPUT), isError: exit !== null && exit !== 0 };
}

export function runSubprocess(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; exit: number | null; timedOut: boolean; durMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
    const child = spawn(shell, ['-c', command], { cwd, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 400_000) out = out.slice(-300_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output: out, exit: code, timedOut, durMs: Date.now() - t0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ output: String(e), exit: 127, timedOut: false, durMs: Date.now() - t0 });
    });
  });
}

function readFile(env: ToolEnv, p: string, offset: number, limit: number): ToolOutcome {
  const abs = resolvePath(p, env.cwd());
  const st = fs.statSync(abs);
  if (st.isDirectory()) return fail(`${abs} is a directory; use list_dir.`);
  if (st.size > 20 * 1024 * 1024) return fail(`${abs} is too large (${(st.size / 1e6).toFixed(1)} MB).`);
  const fd = fs.openSync(abs, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES * 4));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.subarray(0, 8000).includes(0)) return fail(`${abs} looks like a binary file.`);
  const lines = buf.toString('utf8').split('\n');
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length).length;
  const body = slice.map((l, i) => `${String(offset + i).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
  const more = offset - 1 + limit < lines.length ? `\n[… ${lines.length - (offset - 1 + limit)} more lines; use offset=${offset + limit}]` : '';
  return ok(`${body}${more}`);
}

function listDir(env: ToolEnv, p: string, depth: number): ToolOutcome {
  const root = resolvePath(p, env.cwd());
  const out: string[] = [];
  let count = 0;
  const walk = (dir: string, d: number, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch (e) {
      out.push(`${prefix}[unreadable: ${e instanceof Error ? e.message : e}]`);
      return;
    }
    for (const e of entries) {
      if (count++ > 600) return;
      const skip = e.isDirectory() && SKIP_DIRS.has(e.name);
      out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}${skip ? ' (skipped)' : ''}`);
      if (e.isDirectory() && !skip && d < depth) walk(path.join(dir, e.name), d + 1, prefix + '  ');
    }
  };
  walk(root, 1, '');
  if (count > 600) out.push('… (truncated)');
  return ok(`${root}\n${out.join('\n') || '(empty)'}`);
}

async function searchFiles(env: ToolEnv, pattern: string, p: string, glob: string | undefined, signal?: AbortSignal): Promise<ToolOutcome> {
  const root = resolvePath(p, env.cwd());
  // Prefer ripgrep; fall back to a bounded JS walk so the tool works on a bare machine.
  const rg = await runSubprocess(`command -v rg >/dev/null 2>&1 && rg --line-number --no-heading --max-count 20 --max-columns 200 ${glob ? `--glob ${JSON.stringify(glob)}` : ''} -e ${JSON.stringify(pattern)} ${JSON.stringify(root)} | head -200`, env.cwd(), 20_000, signal);
  if (rg.exit === 0 && rg.output.trim()) return ok(rg.output.trim());
  // No ripgrep output: either nothing matched or rg is not installed — the JS walk below covers both.
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return fail(`Invalid regular expression: ${e instanceof Error ? e.message : e}`);
  }
  const globRe = glob ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
  const hits: string[] = [];
  let files = 0;
  const walk = (dir: string): void => {
    if (hits.length >= 200 || files > 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && (!globRe || globRe.test(e.name))) {
        files++;
        try {
          const st = fs.statSync(full);
          if (st.size > 2_000_000) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < 200; i++) if (re.test(lines[i]!)) hits.push(`${full}:${i + 1}:${truncate(lines[i]!, 200)}`);
        } catch {
          /* unreadable */
        }
      }
    }
  };
  const st = fs.statSync(root);
  if (st.isDirectory()) walk(root);
  else {
    const lines = fs.readFileSync(root, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (re.test(l) && hits.length < 200) hits.push(`${root}:${i + 1}:${truncate(l, 200)}`);
    });
  }
  return ok(hits.length ? hits.join('\n') : 'No matches.');
}

function writeFile(env: ToolEnv, p: string, content: string): ToolOutcome {
  const abs = resolvePath(p, env.cwd());
  const existed = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return ok(`${existed ? 'Overwrote' : 'Created'} ${abs} (${content.split('\n').length} lines, ${Buffer.byteLength(content)} bytes).`);
}

function editFile(env: ToolEnv, p: string, oldStr: string, newStr: string, all: boolean): ToolOutcome {
  const abs = resolvePath(p, env.cwd());
  if (oldStr === newStr) return fail('old_string and new_string are identical.');
  const cur = fs.readFileSync(abs, 'utf8');
  const count = oldStr === '' ? 0 : cur.split(oldStr).length - 1;
  if (count === 0) return fail('old_string was not found in the file. Re-read the file and copy the text exactly (whitespace matters).');
  if (count > 1 && !all) return fail(`old_string matches ${count} places. Add surrounding context to make it unique, or set replace_all.`);
  const next = all ? cur.split(oldStr).join(newStr) : cur.replace(oldStr, () => newStr);
  fs.writeFileSync(abs, next);
  return ok(`Edited ${abs} (${all ? count : 1} replacement${count > 1 && all ? 's' : ''}).`);
}
