import type { ClaudeSession } from '../core/claude/watcher';
import type { JafferConfig } from '../shared/config';
import { formatUsd } from '../shared/claude-cost';
import { baseName, budgetLevel, costFigure, countsText, fmtDuration, progressFraction, turnCounts, turnSummaryText } from './claude-ui';

/** The side panel's pure pieces: its width, and what its Now card says (built from what the window already has, nothing new). */

/** `panel.width` as the window uses it: whole pixels, 220..480, 300 for anything that is not a number; with the window's width, also no wider than leaves the terminal 360 px of it (but never under 220). */
export function panelWidth(w: unknown, windowWidth = Infinity): number {
  const kept = typeof w === 'number' && Number.isFinite(w) ? Math.round(Math.min(480, Math.max(220, w))) : 300;
  return Number.isFinite(windowWidth) ? Math.min(kept, Math.max(220, Math.round(windowWidth) - 360)) : kept;
}

/** At most this many edited files are named; the rest are counted. */
const MAX_FILES = 8;

export interface NowCardModel {
  /** `off`: no Claude session. */
  state: 'off' | 'idle' | 'working' | 'needs-you';
  label: string;
  hint?: string;
  /** The tool it runs or asks about (its name only). */
  tool?: string;
  /** How long the turn has taken so far. */
  elapsed?: string;
  /** The turn against the typical one, 0..1, while it works and a typical turn is known (the title bar's ring); null otherwise. */
  progress: number | null;
  /** The cost figure, as the title bar's chip has it (only with `showCost`). */
  cost?: { text: string; live: boolean };
  /** Today's cost against the daily budget (only with `showCost`; `fraction` only with a budget). */
  today?: { text: string; level: 'off' | 'ok' | 'warn' | 'danger'; fraction: number | null };
  /** The running background agents, numbered (their ids are opaque: never shown). */
  agents: string[];
  /** This turn's calls by kind, while the turn goes on ('' for none). */
  counts: string;
  /** The files this turn edited: the name shown, the path for Finder. */
  files: { name: string; path: string }[];
  moreFiles: number;
  /** After a turn: what it took, what Claude did and (with `showCost`) what it cost. */
  summary?: string;
}

export function nowCardModel(
  s: ClaudeSession | null,
  { now, cfg, today, typicalTurnMs }: { now: number; cfg?: Partial<JafferConfig['claude']>; today?: { usd: number } | null; typicalTurnMs?: number },
): NowCardModel {
  const showCost = cfg?.showCost !== false;
  const budget = cfg?.dailyBudgetUsd ?? 0;
  const t = showCost && today && typeof today.usd === 'number' ? today.usd : undefined;
  const m: NowCardModel = {
    state: 'off',
    label: 'Claude is not running',
    hint: 'Press ⇧⌘C to start Claude Code in the terminal.',
    progress: null,
    agents: [],
    counts: '',
    files: [],
    moreFiles: 0,
    today: t === undefined ? undefined : { text: `Today ≈ ${formatUsd(t)}${budget > 0 ? ` of ${formatUsd(budget)}` : ''}`, level: budgetLevel(t, budget), fraction: budget > 0 ? Math.min(1, t / budget) : null },
  };
  if (!s) return m;
  const busy = s.state === 'working' || s.state === 'needs-you';
  const started = typeof s.turnStartedAt === 'number' ? s.turnStartedAt : undefined;
  m.state = s.state === 'working' || s.state === 'needs-you' ? s.state : 'idle';
  m.label = s.state === 'working' ? 'Claude is working' : s.state === 'needs-you' ? 'Claude needs you' : 'Claude is idle';
  m.hint = s.state === 'needs-you' ? 'Answer it in the terminal.' : undefined;
  m.cost = (showCost && costFigure(s, cfg?.liveCost !== false)) || undefined;
  m.agents = (Array.isArray(s.subagents) ? s.subagents : [])
    .filter((a) => a && a.status === 'running' && typeof a.startedAt === 'number')
    .map((a, n) => [`Agent ${n + 1}`, typeof a.tool === 'string' && a.tool ? a.tool : '', fmtDuration(now - a.startedAt)].filter(Boolean).join(' · '));
  const counts = turnCounts(s.calls, started);
  // (a turn without a prompt keeps the last prompt's files: only a turn that wrote lists them)
  const files = counts.write && Array.isArray(s.files) ? s.files.filter((f) => typeof f === 'string') : [];
  m.files = files.slice(0, MAX_FILES).map((path) => ({ name: baseName(path), path }));
  m.moreFiles = files.length - m.files.length;
  if (busy) {
    m.tool = s.tool?.name || undefined;
    m.elapsed = started !== undefined ? fmtDuration(now - started) : undefined;
    m.progress = s.state === 'working' && started !== undefined && (typicalTurnMs ?? 0) > 0 ? progressFraction(now - started, typicalTurnMs!) : null;
    m.counts = countsText(counts, ' · ');
  } else if (started !== undefined && !s.cutShort && s.since >= started) {
    const usd = s.cost?.last && typeof s.cost.last === 'object' ? s.cost.last.usd : undefined;
    m.summary = turnSummaryText({ durMs: s.since - started, counts, usd: showCost ? usd : undefined });
  }
  return m;
}
