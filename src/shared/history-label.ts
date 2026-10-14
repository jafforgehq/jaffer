import type { Conversation } from '../core/claude/history';
import { isSessionId } from './session-id';
import { clipLabel } from './tray-state';

/** The text a past conversation puts on the clipboard (never typed): only for a real session id, since it ends up on a command line. */
export function resumeCommand(id: string): string | null {
  return typeof id === 'string' && isSessionId(id) ? `claude --resume ${id}` : null;
}

/** `/Users/maya/code/api` → `~/code/api` (only at a folder boundary). */
export function tildeOf(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

export function fmtAgo(ts: number | string, now = Date.now()): string {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The menu bar's Past Conversations: the 5 newest with a valid id, `<folder> · <how long ago>` on one line. */
export function historyMenuItems(items: Pick<Conversation, 'id' | 'cwd' | 'endedAt'>[], home: string, now: number): { id: string; label: string }[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((c) => c && isSessionId(c.id))
    .slice(0, 5)
    .map((c) => {
      const folder = c.cwd ? (tildeOf(c.cwd, home) === '~' ? '~' : c.cwd.split('/').filter(Boolean).pop() || '/') : 'Conversation';
      return { id: c.id, label: clipLabel(`${folder} · ${fmtAgo(c.endedAt, now)}`) };
    });
}
