import type { ToolCall } from '../core/claude/watcher';
import type { GitStatus } from '../core/session/git-status';
import { formatUsd } from '../shared/claude-cost';

/** `4m 12s`, `45s`, `1h 3m`. */
export function fmtDuration(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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

/** The calls of the current turn by category. A background-agent turn without a prompt inherits the last prompt's calls: only those since the turn began count. */
export function turnCounts(calls: ToolCall[] | undefined, turnStartedAt: number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of Array.isArray(calls) ? calls : []) if (turnStartedAt === undefined || c.startedAt >= turnStartedAt) out[c.category] = (out[c.category] ?? 0) + 1;
  return out;
}

const WORDS: [string, string, string][] = [
  ['read', 'read', 'reads'],
  ['write', 'edit', 'edits'],
  ['shell', 'shell', 'shells'],
  ['web', 'web', 'web'],
  ['agent', 'agent', 'agents'],
  ['other', 'other', 'other'],
];

/** "Claude finished in 1m 12s · 3 reads, 2 edits, 1 shell · ≈ $0.04". */
export function turnSummaryText({ durMs, counts, usd }: { durMs: number; counts: Record<string, number>; usd?: number }): string {
  const did = WORDS.filter(([k]) => counts[k]! > 0).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
  return [`Claude finished in ${fmtDuration(durMs)}`, did.join(', '), usd !== undefined ? `≈ ${formatUsd(usd)}` : ''].filter(Boolean).join(' · ');
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

/** `+2 ~3 ?1 ↑1 ↓0` with the zeros left out; '' for no repository. */
export function gitText(git: GitStatus | undefined): string {
  if (!git) return '';
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  return (
    [
      ['+', git.staged],
      ['~', git.changed],
      ['?', git.untracked],
      ['↑', git.ahead],
      ['↓', git.behind],
    ] as const
  )
    .filter(([, v]) => n(v))
    .map(([s, v]) => s + v)
    .join(' ');
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
