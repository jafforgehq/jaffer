import type { Conversation } from '../core/claude/history';
import { isSessionId } from './session-id';
import { clipLabel } from './tray-state';
import { fmtDuration } from './claude-text';
import { formatUsd } from './claude-cost';

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

// ------------------------------------------------------------------ the side panel's list (1.1.0)

type Past = Pick<Conversation, 'id' | 'cwd' | 'endedAt' | 'durMs' | 'usd'>;

// fixed names, so a label never depends on the Mac's language
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The conversations by the local day they ended, newest first: "Today", "Yesterday", then "Mon 12 Oct" ("… 2025" in another year); odd times last, under "Earlier". */
export function groupByDay<T extends Pick<Conversation, 'endedAt'>>(items: T[], now: number): { label: string; items: T[] }[] {
  if (!Array.isArray(items)) return [];
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const t = (c: T) => (typeof c?.endedAt === 'number' && Number.isFinite(c.endedAt) ? c.endedAt : -Infinity);
  const groups: { label: string; items: T[] }[] = [];
  for (const c of [...items].sort((a, b) => t(b) - t(a) || 0)) {
    let label = 'Earlier';
    if (t(c) > -Infinity) {
      const d = new Date(t(c));
      const k = dayKey(d);
      label = k === dayKey(today) ? 'Today' : k === dayKey(yesterday) ? 'Yesterday' : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
    }
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

/** The conversations whose folder (as shown, with ~) holds the text, in any case. */
export function filterByFolder<T extends Pick<Conversation, 'cwd'>>(items: T[], q: string, home: string): T[] {
  const t = q.trim().toLowerCase();
  return t ? items.filter((c) => !!c.cwd && tildeOf(c.cwd, home).toLowerCase().includes(t)) : items;
}

/** One row of the list: the folder's name, its `~/…` path, the time of day it ended (HH:MM), how long it went, and the cost (null: not shown). */
export function conversationRow(c: Past, home: string, showCost: boolean): { name: string; dir: string; time: string; dur: string; cost: string | null } {
  const dir = c.cwd ? tildeOf(c.cwd, home) : '';
  const name = !c.cwd ? '(folder unknown)' : dir === '~' ? '~' : c.cwd.split('/').filter(Boolean).pop() || '/';
  const d = new Date(c.endedAt);
  const time = Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '–';
  const dur = typeof c.durMs === 'number' ? fmtDuration(c.durMs) : '–';
  return { name, dir, time, dur, cost: showCost ? (typeof c.usd === 'number' ? `≈ ${formatUsd(c.usd)}` : '–') : null };
}
