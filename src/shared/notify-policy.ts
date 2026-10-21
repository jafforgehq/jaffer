import type { ClaudeSession } from '../core/claude/watcher';
import { isSensitiveCommand, redactText } from './redact';
import { COMMAND_HEAD } from './process-badge';
import { isPaneId } from './session-id';

/** Claude Code's own terminal notification (OSC 9) and ours must not both fire for one event. */
const TERMINAL_NOTIFY_WINDOW_MS = 10_000;

/**
 * The desktop notification for "Claude needs you", or null. Only when a session newly enters `needs-you`, the window is
 * not in front of the user, and no terminal notification was shown in the last 10 seconds.
 */
export function needsYouNotification(
  prev: ClaudeSession[],
  next: ClaudeSession[],
  ctx: { windowFocused: boolean; lastTerminalNotifyAt: number; now: number; where?: (s: ClaudeSession) => string },
): { title: string; body: string; pane?: string } | null {
  if (ctx.windowFocused || ctx.now - ctx.lastTerminalNotifyAt < TERMINAL_NOTIFY_WINDOW_MS) return null;
  const was = new Map(prev.map((s) => [s.id, s.state]));
  const hit = next.find((s) => s.state === 'needs-you' && was.get(s.id) !== 'needs-you');
  if (!hit) return null;
  const where = ctx.where?.(hit);
  return { title: 'Claude needs you', body: `${where ? `${where}: ` : ''}${hit.notice || 'Claude is waiting for your permission.'}`, ...(hit.pane ? { pane: hit.pane } : {}) };
}

/**
 * (1.5.0) Which terminal a notification is about: its folder's name, only with two or more terminals (with one there is nothing to tell
 * apart) and only for a plain pane id. The folder is the daemon's `cwd`, which a program can set to anything: only its last 4 * COMMAND_HEAD
 * characters are read, the last folder name is taken, control and format characters leave it, it is redacted and cut to 40.
 */
export function terminalWhere(pane: string | undefined, folders: ReadonlyMap<string, string>, paneCount: number): string {
  if (paneCount < 2 || !isPaneId(pane)) return '';
  const tail = (folders.get(pane) ?? '').slice(-4 * COMMAND_HEAD);
  const base = tail.split('/').filter(Boolean).pop() ?? '';
  const clean = redactText(base.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')).trim().slice(0, 40);
  return clean || 'another terminal';
}

/** A command that ran this long while Jaffer was in the background is worth a notification when it ends. */
const LONG_COMMAND_MS = 30_000;

/**
 * "A long command finished", or null. Notification Center keeps what it is shown, so the command goes through the same rules as
 * everywhere else: secrets redacted, a sensitive command (a password on the command line, an ssh key) not named at all.
 */
/** `45s`, `2 min`: how long something took, for a notification. */
export function took(ms: number): string {
  const secs = Math.round(ms / 1000);
  return secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
}

export function commandNotification(c: { cmd: string; exit: number | null; durMs: number }, ctx: { windowFocused: boolean }): { title: string; body: string } | null {
  if (c.durMs < LONG_COMMAND_MS || ctx.windowFocused || !c.cmd.trim()) return null;
  const head = c.cmd.slice(0, 4 * COMMAND_HEAD); // a command line is forgeable at any length: only its head is read
  const shown = isSensitiveCommand(head) ? 'A command' : redactText(head).replace(/\s+/g, ' ').trim().slice(0, 120);
  return { title: c.exit === 0 ? 'Command finished' : `Command failed (exit ${c.exit})`, body: `${shown} — ${took(c.durMs)}` };
}

/** A bell bounces the Dock icon at most this often. */
const BOUNCE_GAP_MS = 5_000;

/** Whether a bell at `now` may bounce the Dock icon, given when it last did (a clock that went backwards waits). */
export function shouldBounce(now: number, last: number): boolean {
  return now - last >= BOUNCE_GAP_MS;
}
