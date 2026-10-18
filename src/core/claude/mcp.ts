import { spawn } from 'node:child_process';
import path from 'node:path';
import { isShellPath } from '../../shared/osc';
import { cleanLine } from './setup';

/**
 * (1.4.0) Are the MCP servers answering? `claude mcp list` has no JSON: it prints a line per server ("<name>: <command or URL> - <state>"),
 * and it starts every stdio server to ask it, so it runs only when the person clicks *Check MCP servers*. Only the name (cleaned, redacted,
 * 64 characters) and the state (by Claude Code's documented words) are kept: never the command, an argument or a URL.
 */
export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'unknown';
export interface McpServer {
  name: string;
  status: McpStatus;
  label: string;
}
export interface McpCheck {
  servers: McpServer[];
  ok: boolean;
  reason?: 'no-claude' | 'timeout' | 'error';
  /** (the daemon's answer) The folder it ran in. */
  cwd?: string;
  /** (1.4.1) The folder's settings pre-approve its project servers, so the check ran in the home folder (`cwd`) instead: see mcp-gate.ts. */
  gated?: boolean;
}

export const MCP_LABEL: Record<McpStatus, string> = {
  connected: 'Connected',
  'needs-auth': 'Needs sign-in',
  failed: 'Failed to connect',
  pending: 'Waiting for approval',
  disabled: 'Disabled',
  unknown: 'State not known',
};
/** How much of its output is read (and kept from the process). */
const OUT_MAX = 64 * 1024;
const MAX_SERVERS = 100;

function statusOf(text: string): McpStatus {
  const t = text.toLowerCase();
  if (t.includes('needs authentication')) return 'needs-auth';
  if (t.includes('failed to connect') || t.includes('connection error')) return 'failed';
  if (t.includes('pending approval')) return 'pending';
  if (t.includes('disabled')) return 'disabled';
  return /\bconnected\b/.test(t) ? 'connected' : 'unknown';
}

/** What a claude.ai connector's name is followed by: a URL (any scheme). */
const URL_TARGET = /^[a-z][a-z0-9+.-]{0,30}:\/\//i;
/** Where a claude.ai name may end: the first 8 ": " within the first 512 characters of a line. */
const NAME_END_MAX = 512;

/**
 * The servers of `claude mcp list`'s text, tolerantly: a line is "<name>: <target> - <state>" (or "<name>: <target>" with a state word);
 * others are skipped. A name ends at the first ": ", so `plugin:context7:context7` stays whole. (1.4.2) Only a line that starts with
 * `claude.ai ` (Claude Code's connectors, the only names with spaces or ": " in them) may end its name at a later ": ", the first one a
 * URL follows; a command's own ": " (`--token: x`) can then never become part of a name.
 */
export function parseMcpList(text: string): McpServer[] {
  const out: McpServer[] = [];
  // (links and titles (OSC, with what they carry) and colours (CSI) out first)
  const plain = text
    .slice(0, OUT_MAX)
    .replace(/\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const raw of plain.split(/\r\n|\r|\n/)) {
    if (out.length >= MAX_SERVERS) break;
    const line = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    if (line.startsWith('Error')) continue; // (what went wrong, not a server)
    let i = line.indexOf(': ');
    if (i > NAME_END_MAX) i = -1;
    if (i > 0 && line.startsWith('claude.ai ')) {
      for (let j = i, k = 0; j > 0 && j <= NAME_END_MAX && k < 8; j = line.indexOf(': ', j + 2), k++) {
        if (URL_TARGET.test(line.slice(j + 2, j + 2 + 40))) {
          i = j;
          break;
        }
      }
    }
    if (i <= 0) continue;
    const rest = line.slice(i + 1);
    const dash = rest.lastIndexOf(' - ');
    const status = statusOf(dash >= 0 ? rest.slice(dash + 3) : rest);
    if (status === 'unknown' && dash < 0) continue;
    const name = cleanLine(line.slice(0, i), 64);
    if (name) out.push({ name, status, label: MCP_LABEL[status] });
  }
  return out;
}

/** (1.4.2) The tool folders a Mac app started from the Dock lacks, added (once each, when they exist) when the shell's PATH is not known. */
export const MCP_PATH_EXTRA = (home: string) => [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

/**
 * (1.4.2) The PATH `claude mcp list` runs with: the focused shell's own (`shellPath`, what its startup files made) when it reported a usable
 * one, else the app's PATH with `MCP_PATH_EXTRA` appended. A Mac app started from the Dock has only `/usr/bin:/bin:/usr/sbin:/sbin`, and
 * the servers started with `npx`, `node` or `uvx` then fail with ENOENT although they work.
 */
export function mcpPath(shellPath: string | undefined, appPath: string | undefined, home: string, exists: (dir: string) => boolean): string {
  // (review) only absolute folders: ".", an empty entry or a relative one would make the spawn find a program of the checked folder (a
  // cloned repository's own ./npx)
  const absolute = (p: string | undefined) => (p ?? '').split(':').filter((d) => path.isAbsolute(d));
  const shell = isShellPath(shellPath) ? absolute(shellPath) : [];
  if (shell.length) return shell.join(':');
  const parts = absolute(appPath);
  for (const d of MCP_PATH_EXTRA(home)) if (!parts.includes(d) && exists(d)) parts.push(d);
  // (never an empty PATH, which can mean "this folder": the PATH of an app started from the Dock)
  return parts.length ? parts.join(':') : '/usr/bin:/bin:/usr/sbin:/sbin';
}

/** The process groups of the checks under way (their leaders' pids), so the daemon can end them when it stops. */
const live = new Set<number>();

function killGroup(pid: number | undefined): void {
  try {
    if (pid) process.kill(-pid, 'SIGKILL');
  } catch {
    /* gone already (ESRCH) */
  }
}

/** Ends every check under way, with whatever it started (the daemon stopping). */
export function stopMcpChecks(): void {
  for (const pid of live) killGroup(pid);
}

/**
 * `claude mcp list` once, in `cwd`: no shell, without Jaffer's session variables, in its own process group, which is ended (SIGKILL) as
 * soon as it exits, after `timeoutMs`, or by `stopMcpChecks`: a server it started never outlives it. The first 64 KB of its output counts
 * and the rest is drained unread.
 */
export function runMcpList(claude: string | null, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 25_000): Promise<McpCheck> {
  if (!claude) return Promise.resolve({ servers: [], ok: false, reason: 'no-claude' });
  const e = { ...env };
  delete e.JAFFER_SESSION;
  delete e.JAFFER_PANE;
  delete e.JAFFER_OWNED;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let exit: number | null | undefined;
    const finish = (reason?: McpCheck['reason']) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(child?.pid);
      if (child?.pid) live.delete(child.pid);
      const servers = reason === 'no-claude' ? [] : parseMcpList(out);
      resolve(reason ? { servers, ok: false, reason } : { servers, ok: true });
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(claude, ['mcp', 'list'], { cwd, env: e, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ servers: [], ok: false, reason: 'no-claude' });
    }
    const pid = child.pid;
    if (pid) live.add(pid);
    const timer = setTimeout(() => {
      killGroup(pid);
      finish(exit === 0 ? undefined : 'timeout'); // (it ended, but its output stayed open)
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => void (out.length < OUT_MAX && (out = (out + d).slice(0, OUT_MAX))));
    child.on('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ENOENT' || err.code === 'EACCES' ? 'no-claude' : 'error'));
    // (ended: whatever it started goes with it, which also lets go of the output)
    child.on('exit', (code) => ((exit = code), killGroup(pid)));
    child.on('close', (code) => finish(code === 0 ? undefined : 'error'));
  });
}
