import { formatUsd } from '../shared/claude-cost';
import { countsText, fmtDuration } from '../shared/claude-text';

// (the pure pieces the menu bar item in the main process shares live in shared/claude-text)
export { fmtDuration, gitText, turnCalls, turnCounts } from '../shared/claude-text';

/** How far a turn is against the typical one, 0..1 (0 when no typical length is known yet). */
export function progressFraction(elapsedMs: number, typicalMs: number): number {
  if (!(typicalMs > 0) || !(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / typicalMs);
}

/** Today's estimated cost against the daily budget: `warn` from 80 %, `danger` from 100 %. */
export function budgetLevel(todayUsd: number, budgetUsd: number): 'off' | 'ok' | 'warn' | 'danger' {
  if (!(budgetUsd > 0)) return 'off';
  const r = todayUsd / budgetUsd;
  return r >= 1 ? 'danger' : r >= 0.8 ? 'warn' : 'ok';
}

/** "Claude finished in 1m 12s · 3 reads, 2 edits, 1 shell · ≈ $0.04". */
export function turnSummaryText({ durMs, counts, usd }: { durMs: number; counts: Record<string, number>; usd?: number }): string {
  return [`Claude finished in ${fmtDuration(durMs)}`, countsText(counts), usd !== undefined ? `≈ ${formatUsd(usd)}` : ''].filter(Boolean).join(' · ');
}

/** "Claude · 42 min · 9 turns · ≈ $1.20". */
export function sessionClockText({ startedAt, now, turns, usd }: { startedAt?: number; now: number; turns?: number; usd?: number }): string {
  const parts = ['Claude'];
  if (typeof startedAt === 'number' && startedAt > 0) {
    const m = Math.floor(Math.max(0, now - startedAt) / 60_000);
    parts.push(m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
  }
  if (typeof turns === 'number') parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  if (usd !== undefined) parts.push(`≈ ${formatUsd(usd)}`);
  return parts.join(' · ');
}

export const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? '';

export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** An SVG path through `values`, scaled into a `w` × `h` box (a flat line sits in the middle); '' for fewer than two values. */
export function sparkPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const r = (v: number) => Math.round(v * 10) / 10;
  return values.map((v, i) => `${i ? 'L' : 'M'}${r((i * w) / (values.length - 1))} ${r(span ? h - ((v - min) / span) * h : h / 2)}`).join(' ');
}

/**
 * Settings → Claude Code → Hook health: `events` is when each hook event was last heard (ms since epoch, null: not yet). A session began
 * over an hour ago and no `Stop` has come since while nothing works means the hooks are probably not reaching Jaffer; null otherwise.
 */
export function hookHealthWarning(events: Record<string, number | null>, now: number, anyWorking: boolean): string | null {
  const start = events.SessionStart;
  if (anyWorking || typeof start !== 'number' || !(now - start > 3_600_000)) return null;
  const stop = events.Stop;
  if (typeof stop === 'number' && stop >= start) return null;
  return 'Stop has not arrived for over an hour: the hooks may be broken. Try Reinstall.';
}
