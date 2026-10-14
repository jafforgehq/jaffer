import { formatTokens, formatUsd } from '../shared/claude-cost';
import { countsText, fmtDuration } from '../shared/claude-text';
import type { ClaudeSession } from '../core/claude/watcher';

// (the pure pieces the menu bar item in the main process shares live in shared/claude-text)
export { countsText, fmtDuration, gitText, turnCalls, turnCounts } from '../shared/claude-text';

/** What every cost figure is, said on hover. */
export const COST_ESTIMATE = 'An estimate at API list prices, from token counts: a subscription is not billed per token.';

/**
 * The cost figure of the title bar's chip and the side panel: while Claude works (with `liveCost`), what the answer has cost so far
 * (`live`); otherwise what the last answer cost; null for neither.
 */
export function costFigure(s: ClaudeSession, liveCost: boolean): { text: string; live: boolean } | null {
  const l = s.cost && typeof s.cost === 'object' && s.cost.last && typeof s.cost.last === 'object' ? s.cost.last : undefined;
  const lv = liveCost && (s.state === 'working' || s.state === 'needs-you') ? s.live : undefined;
  if (lv && typeof lv === 'object') return { live: true, text: lv.usd !== undefined ? `≈ ${formatUsd(lv.usd)} so far` : `${formatTokens(lv.input + lv.output)} tokens so far` };
  if (l) return { live: false, text: l.usd !== undefined ? `≈ ${formatUsd(l.usd)}` : `${formatTokens(l.input + l.output + l.cacheRead + l.cacheWrite)} tokens` };
  return null;
}

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
