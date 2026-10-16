import { formatUsd } from './claude-cost';
import { fmtDuration } from './claude-text';

/**
 * The weekly numbers (1.4.0): what this week's and last week's answers cost (estimated dollars) and how long Claude worked, kept in
 * `config.json` as `usage` (numbers and ISO week ids only), for the weekly digest at the app's start. Pure: the daemon adds every counted
 * turn (`rollWeek`), main asks `digestDue` once at its start.
 */
export interface UsageWeek {
  /** `2026-W42`; empty: no week yet. */
  id: string;
  usd: number;
  workMs: number;
}
export interface UsageWeeks {
  week: UsageWeek;
  lastWeek: UsageWeek;
  /** The week the digest last told about. */
  digestWeek: string;
}

const DAY = 86_400_000;

/** The ISO week (Monday to Sunday; week 1 holds the year's first Thursday) of a local time: `2026-W42`; empty for a time that is not one. */
export function weekId(time: number): string {
  const d = new Date(time);
  if (!Number.isFinite(d.getTime())) return '';
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const firstThursday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + 3);
  // (whole days apart: a summer-time change in between is an hour, which the rounding takes away)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const week = (w: unknown): UsageWeek => {
  const o = w && typeof w === 'object' ? (w as Record<string, unknown>) : {};
  return { id: typeof o.id === 'string' ? o.id : '', usd: num(o.usd), workMs: num(o.workMs) };
};

/** `usage` with a counted turn added at `now` (its estimated dollars, its time: one under a second is no time); a new week moves this week to last week. */
export function rollWeek(usage: UsageWeeks, now: number, usd = 0, workMs = 0): UsageWeeks {
  const id = weekId(now);
  let cur = week(usage?.week);
  let last = week(usage?.lastWeek);
  if (cur.id !== id) {
    if (cur.id) last = cur;
    cur = { id, usd: 0, workMs: 0 };
  }
  const add = Number.isFinite(workMs) && workMs >= 1000 ? workMs : 0;
  return { week: { id, usd: cur.usd + num(usd), workMs: cur.workMs + add }, lastWeek: last, digestWeek: typeof usage?.digestWeek === 'string' ? usage.digestWeek : '' };
}

/**
 * The week the digest should tell about at `now`, or null: the week just past (this week's numbers when no turn was counted since the
 * week changed, else last week's), when it had any cost or time and the digest has not told about it yet.
 */
export function digestDue(usage: UsageWeeks, now: number): UsageWeek | null {
  if (!usage || typeof usage !== 'object') return null;
  const d = new Date(now);
  const past = weekId(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7, 12).getTime());
  const cur = week(usage.week);
  const w = cur.id === past ? cur : week(usage.lastWeek);
  return w.id === past && w.id !== usage.digestWeek && (w.usd > 0 || w.workMs > 0) ? w : null;
}

/** The digest's notification: "≈ $12.40, 12h 30m" (the money only with `showCost`). */
export function digestText(w: UsageWeek, showCost: boolean): { title: string; body: string } {
  const parts = [showCost && w.usd > 0 ? `≈ ${formatUsd(w.usd)}` : '', w.workMs >= 1000 ? fmtDuration(w.workMs) : ''].filter(Boolean);
  return { title: 'Last week with Claude', body: parts.join(', ') || 'Claude Code worked with you last week.' };
}
