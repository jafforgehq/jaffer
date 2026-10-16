import { spawn } from 'node:child_process';
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

/** The servers of `claude mcp list`'s text, tolerantly: a line is "<name>: …" with a state word or a " - " before the state; others are skipped. */
export function parseMcpList(text: string): McpServer[] {
  const out: McpServer[] = [];
  // (colours out first; a name ends at the first ": ", so a plugin's "plugin:x:y" stays whole)
  for (const raw of text.slice(0, OUT_MAX).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r\n|\r|\n/)) {
    if (out.length >= MAX_SERVERS) break;
    const line = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    let i = line.indexOf(': ');
    if (i < 0) i = line.indexOf(':');
    const head = line.slice(0, i).trim();
    if (i <= 0 || /\s/.test(head)) continue;
    const rest = line.slice(i + 1);
    const dash = rest.lastIndexOf(' - ');
    const status = statusOf(dash >= 0 ? rest.slice(dash + 3) : rest);
    if (status === 'unknown' && dash < 0) continue;
    const name = cleanLine(head, 64);
    if (name) out.push({ name, status, label: MCP_LABEL[status] });
  }
  return out;
}

/**
 * `claude mcp list` once, in `cwd`: no shell, without Jaffer's session variables, in its own process group (so the servers it starts go
 * with it), stopped (SIGKILL, the whole group) after `timeoutMs`; the first 64 KB of its output counts and the rest is drained unread.
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
      const servers = reason === 'no-claude' ? [] : parseMcpList(out);
      resolve(reason ? { servers, ok: false, reason } : { servers, ok: true });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claude, ['mcp', 'list'], { cwd, env: e, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ servers: [], ok: false, reason: 'no-claude' });
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone already */
      }
      finish(exit === 0 ? undefined : 'timeout'); // (it ended, but something it started kept the output open)
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => void (out.length < OUT_MAX && (out = (out + d).slice(0, OUT_MAX))));
    child.on('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ENOENT' || err.code === 'EACCES' ? 'no-claude' : 'error'));
    child.on('exit', (code) => void (exit = code));
    child.on('close', (code) => finish(code === 0 ? undefined : 'error'));
  });
}
