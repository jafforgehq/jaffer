import type { ClaudeSession } from '../core/claude/watcher';
import { isSensitiveCommand, redactText } from './redact';

/** Claude Code's own terminal notification (OSC 9) and ours must not both fire for one event. */
const TERMINAL_NOTIFY_WINDOW_MS = 10_000;

/**
 * The desktop notification for "Claude needs you", or null. Only when a session newly enters `needs-you`, the window is
 * not in front of the user, and no terminal notification was shown in the last 10 seconds.
 */
export function needsYouNotification(
  prev: ClaudeSession[],
  next: ClaudeSession[],
  ctx: { windowFocused: boolean; lastTerminalNotifyAt: number; now: number },
): { title: string; body: string } | null {
  if (ctx.windowFocused || ctx.now - ctx.lastTerminalNotifyAt < TERMINAL_NOTIFY_WINDOW_MS) return null;
  const was = new Map(prev.map((s) => [s.id, s.state]));
  const hit = next.find((s) => s.state === 'needs-you' && was.get(s.id) !== 'needs-you');
  return hit ? { title: 'Claude needs you', body: hit.notice || 'Claude is waiting for your permission.' } : null;
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
  const shown = isSensitiveCommand(c.cmd) ? 'A command' : redactText(c.cmd).replace(/\s+/g, ' ').trim().slice(0, 120);
  return { title: c.exit === 0 ? 'Command finished' : `Command failed (exit ${c.exit})`, body: `${shown} — ${took(c.durMs)}` };
}
