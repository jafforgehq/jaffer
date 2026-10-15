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

/** What a conversation is called: the person's own name (`history.names`, 1.2.0), else its title, else (given the home) its folder with ~, else "Conversation". */
export function conversationName(c: Pick<Conversation, 'id' | 'title' | 'cwd'>, names?: Map<string, string>, home?: string): string {
  return names?.get(c.id) || (typeof c.title === 'string' && c.title ? c.title : home !== undefined && c.cwd ? tildeOf(c.cwd, home) : 'Conversation');
}

/** ⇧⌘R (1.2.0): the list read just now; when the read fails, the last one the window had (null: none), and why. */
export async function freshList<T>(read: () => Promise<T[]>, cached: T[] | null): Promise<{ items: T[] | null; error?: string }> {
  try {
    return { items: await read() };
  } catch (e) {
    return { items: cached, error: e instanceof Error ? e.message : 'Could not read the past conversations.' };
  }
}

/**
 * Reads whose answers replace one list (the panel's, the palette's at every open, ⇧⌘R's): each read is numbered, and its answer is the
 * newest only when no read began after it. An older answer is not to be kept; an older failure is not an error any more.
 */
export function newestOnly(): <T>(read: () => Promise<T>) => Promise<{ value?: T; newest: boolean }> {
  let last = 0;
  return async (read) => {
    const n = ++last;
    try {
      const value = await read();
      return { value, newest: n === last };
    } catch (e) {
      if (n === last) throw e;
      return { newest: false };
    }
  };
}

/** The menu bar's Past Conversations: the 5 newest with a valid id, `<name, title or folder> · <how long ago>` on one line (the name clipped to 40). */
export function historyMenuItems(items: Pick<Conversation, 'id' | 'cwd' | 'endedAt' | 'title'>[], home: string, now: number, names?: Map<string, string>): { id: string; label: string }[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((c) => c && isSessionId(c.id))
    .slice(0, 5)
    .map((c) => {
      const folder = c.cwd ? (tildeOf(c.cwd, home) === '~' ? '~' : c.cwd.split('/').filter(Boolean).pop() || '/') : 'Conversation';
      const own = names?.get(c.id) || (typeof c.title === 'string' ? c.title : '');
      const name = own ? clipLabel(own, 40) : folder;
      return { id: c.id, label: clipLabel(`${name} · ${fmtAgo(c.endedAt, now)}`) };
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

/** The conversations whose name, title or folder (as shown, with ~) holds the text, in any case. */
export function filterByFolder<T extends Pick<Conversation, 'id' | 'cwd' | 'title'>>(items: T[], q: string, home: string, names?: Map<string, string>): T[] {
  const t = q.trim().toLowerCase();
  const has = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(t);
  return t ? items.filter((c) => has(names?.get(c.id)) || has(c.title) || (!!c.cwd && has(tildeOf(c.cwd, home)))) : items;
}

/** The pinned conversations (newest first) as a "Pinned" group above the days; a pinned one is not in its day again. */
export function groupConversations<T extends Pick<Conversation, 'id' | 'endedAt'>>(items: T[], now: number, pinned: string[]): { label: string; items: T[] }[] {
  const pin = new Set(pinned);
  const seen = new Set<string>();
  const once = items.filter((c) => !seen.has(c.id) && !!seen.add(c.id)); // (one row per id: rows are keyed by it)
  const top = once.filter((c) => pin.has(c.id));
  const days = groupByDay(once.filter((c) => !pin.has(c.id)), now);
  return top.length ? [{ label: 'Pinned', items: groupByDay(top, now).flatMap((g) => g.items) }, ...days] : days;
}

const folderName = (cwd: string, home: string) => (tildeOf(cwd, home) === '~' ? '~' : cwd.split('/').filter(Boolean).pop() || '/');
const endOf = (c: Pick<Conversation, 'endedAt'>) => (typeof c.endedAt === 'number' && Number.isFinite(c.endedAt) ? c.endedAt : -Infinity);

/** The folder chips (1.2.0): the 5 folders with the most conversations (a tie: the one used last first), its short name (its ~ path when two share it) and its ~ path. */
export function topFolders(items: Pick<Conversation, 'cwd' | 'endedAt'>[], home: string): { cwd: string; label: string; dir: string }[] {
  if (!Array.isArray(items)) return [];
  const by = new Map<string, { n: number; last: number }>();
  for (const c of items) {
    if (!c?.cwd) continue;
    const f = by.get(c.cwd) ?? { n: 0, last: -Infinity };
    by.set(c.cwd, { n: f.n + 1, last: Math.max(f.last, endOf(c)) });
  }
  const top = [...by]
    .sort(([, a], [, b]) => b.n - a.n || b.last - a.last)
    .slice(0, 5)
    .map(([cwd]) => ({ cwd, label: folderName(cwd, home), dir: tildeOf(cwd, home) }));
  return top.map((f) => (top.filter((g) => g.label === f.label).length > 1 ? { ...f, label: f.dir } : f));
}

/**
 * Cost by folder (1.2.0): of the conversations with a cost (the daemon prices the 30 newest), what each folder's cost today (since local
 * midnight) and this week (the last 7 days, up to now); the 5 folders with the most this week.
 */
export function costByFolder(items: Pick<Conversation, 'cwd' | 'endedAt' | 'usd'>[], now: number, home: string): { cwd: string; dir: string; today: number; week: number }[] {
  if (!Array.isArray(items)) return [];
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const by = new Map<string, { today: number; week: number }>();
  for (const c of items) {
    const t = c ? endOf(c) : -Infinity;
    if (!c?.cwd || typeof c.usd !== 'number' || !Number.isFinite(c.usd) || t > now || t <= now - 7 * 86_400_000) continue;
    const f = by.get(c.cwd) ?? { today: 0, week: 0 };
    by.set(c.cwd, { today: f.today + (t >= midnight ? c.usd : 0), week: f.week + c.usd });
  }
  return [...by]
    .sort(([, a], [, b]) => b.week - a.week || b.today - a.today)
    .slice(0, 5)
    .map(([cwd, f]) => ({ cwd, dir: tildeOf(cwd, home), ...f }));
}

/** Resume Last Conversation (⇧⌘R): the newest conversation in the shell's folder, else the newest of all (a valid id only). */
export function lastConversation<T extends Pick<Conversation, 'id' | 'cwd' | 'endedAt'>>(items: T[], cwd: string): T | undefined {
  const ok = (Array.isArray(items) ? items : []).filter((c) => c && isSessionId(c.id)).sort((a, b) => endOf(b) - endOf(a));
  return (cwd ? ok.find((c) => c.cwd === cwd) : undefined) ?? ok[0];
}

/** The palette's conversations: with 2 typed characters or more, at most 5 whose name, title or folder match. */
export function paletteConversations<T extends Pick<Conversation, 'id' | 'cwd' | 'title'>>(items: T[] | null, q: string, home: string, names?: Map<string, string>): T[] {
  return Array.isArray(items) && q.trim().length >= 2 ? filterByFolder(items, q, home, names).slice(0, 5) : [];
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
