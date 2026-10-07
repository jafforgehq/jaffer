import type { ClaudeSession } from '../core/claude/watcher';

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
