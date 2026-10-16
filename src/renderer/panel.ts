import type { ClaudeSession } from '../core/claude/watcher';
import type { JafferConfig } from '../shared/config';
import { formatTokens, formatUsd } from '../shared/claude-cost';
import { baseName, budgetLevel, costFigure, countsText, fmtDuration, progressFraction, turnBars, turnCounts, turnSummaryText } from './claude-ui';

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
  /** The last turns as bars (needs two turns; titles carry the cost only with `showCost`). */
  bars?: NonNullable<ReturnType<typeof turnBars>>;
  /** "Claude worked 1h 12m today": the day's finished turns and, while one runs, its time so far (hidden for none; not tied to `showCost`). */
  worked?: string;
  /** (1.4.0) The worked time against `claude.dailyWorkBudgetMin` (the cost budget's levels; `off` without a budget). */
  workedLevel: 'off' | 'ok' | 'warn' | 'danger';
  /** (1.4.0) The context meter: how full the latest response left the context window (an estimate; `fraction` null when the window is not known; only with `showCost`). */
  context?: { text: string; level: 'ok' | 'warn' | 'danger'; fraction: number | null };
  /** (1.4.0) "Last 5 h ≈ $4.50 · 3.2M tokens (…)": the responses of the last 5 hours across the transcripts (only with `showCost`; the money when priced). */
  last5h?: string;
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
  { now, cfg, today, typicalTurnMs, turns, usage5h }: { now: number; cfg?: Partial<JafferConfig['claude']>; today?: { usd: number; workMs?: number } | null; typicalTurnMs?: number; turns?: { durMs: number; usd?: number }[]; usage5h?: { tokens: number; usd?: number } | null },
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
    workedLevel: 'off',
    today: t === undefined ? undefined : { text: `Today ≈ ${formatUsd(t)}${budget > 0 ? ` of ${formatUsd(budget)}` : ''}`, level: budgetLevel(t, budget), fraction: budget > 0 ? Math.min(1, t / budget) : null },
  };
  m.bars = (turns && turnBars(turns, showCost)) || undefined;
  const busy = !!s && (s.state === 'working' || s.state === 'needs-you');
  const started = typeof s?.turnStartedAt === 'number' ? s.turnStartedAt : undefined;
  const worked = (Number.isFinite(today?.workMs) ? today!.workMs! : 0) + (busy && started !== undefined ? Math.max(0, now - started) : 0);
  if (worked >= 1000) m.worked = `Claude worked ${fmtDuration(worked)} today`;
  m.workedLevel = budgetLevel(worked, Math.max(0, cfg?.dailyWorkBudgetMin ?? 0) * 60_000);
  const u = usage5h;
  if (showCost && u && Number.isFinite(u.tokens) && u.tokens > 0) {
    const money = typeof u.usd === 'number' && Number.isFinite(u.usd) ? ` ≈ ${formatUsd(u.usd)}` : '';
    m.last5h = `Last 5 h${money} · ${formatTokens(u.tokens)} tokens (estimate, not your plan's limit)`;
  }
  if (!s) return m;
  const c = showCost && s.context && typeof s.context === 'object' ? s.context : undefined;
  if (c && Number.isFinite(c.tokens) && c.tokens > 0) {
    // (more than the table's window: the table is wrong for this model, so no share is claimed)
    const f = typeof c.window === 'number' && c.window > 0 && c.tokens <= c.window ? c.tokens / c.window : null;
    m.context = f === null ? { text: `Context ${formatTokens(c.tokens)} tokens`, level: 'ok', fraction: null } : { text: `Context ${Math.round(f * 100)}% of ${formatTokens(c.window!)}`, level: f >= 0.92 ? 'danger' : f >= 0.8 ? 'warn' : 'ok', fraction: f };
  }
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

/** A budget in minutes as words: "3 h", "1 h 30 min", "45 min". */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** (1.4.0) Today's timeline: the turns that ended today (local), newest first, at most 20: "14:30 · 1m 12s · 3 reads, 2 edits · 2 files · ≈ $0.04". */
export function todayTimeline(turns: { durMs: number; usd?: number; at?: number; counts?: string; files?: number }[], now: number, showCost: boolean): string[] {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return turns
    .filter((t): t is typeof t & { at: number } => typeof t.at === 'number' && t.at >= midnight && t.at <= now + 60_000)
    .slice(-20)
    .reverse()
    .map((t) => {
      const e = new Date(t.at);
      const files = typeof t.files === 'number' && t.files > 0 ? `${t.files} file${t.files === 1 ? '' : 's'}` : '';
      const usd = showCost && typeof t.usd === 'number' && Number.isFinite(t.usd) ? `≈ ${formatUsd(t.usd)}` : '';
      return [`${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`, fmtDuration(t.durMs), t.counts ?? '', files, usd].filter(Boolean).join(' · ');
    });
}
