import os from 'node:os';
import fs from 'node:fs';
import type { JafferPaths } from '../../shared/paths';
import type { ConfigStore } from '../../shared/config';
import { Emitter, SerialQueue, errMsg, nowIso, writeFileAtomic } from '../../shared/util';
import { isSensitiveCommand } from '../../shared/redact';
import { MemoryStore, type RunCtx } from './store';
import { similarity } from './text';
import { CursorFile, EpisodeLog, type CursorState } from './episodes';
import { extractDirectives, runHeuristics, type HeuristicEnv } from './heuristics';
import { applyOps, emptyCounts, type ApplyCounts } from './apply';
import { consolidateHeuristic } from './consolidate';
import { buildContext, writeViews, type BuiltContext, type ContextOptions } from './context';
import { DEFAULT_POLICY, reflectWithLlm } from './reflector';
import type { LlmClient } from './llm';
import { syncClaudeSkills, syncExports } from './exports';
import type { CommandEpisode, Episode, EpisodeInput, MemoryItem, MemoryKind, MemoryScope, MemoryStats, ReflectionResult, SkillItem } from './types';
import { MEMORY_KINDS } from './types';
import { rankItems, rankSkills } from './ranking';

export type MemoryEvent =
  | { type: 'updated'; reason: string }
  | { type: 'reflection'; result: ReflectionResult }
  | { type: 'learned'; items: MemoryItem[] };

export interface EngineDeps {
  paths: JafferPaths;
  config: ConfigStore;
  /** Returns a model client when credentials are available, else null. */
  llm?: () => LlmClient | null;
  clock?: () => number;
  home?: string;
  env?: HeuristicEnv;
}

export interface RecallResult {
  items: (MemoryItem & { score: number })[];
  skills: (SkillItem & { score: number })[];
}

/**
 * The self-evolving memory. It watches the session (commands, agent turns, external agent
 * transcripts), reflects on it in the background — offline rules always, a model when
 * available — and keeps a small, ranked, decaying memory that Claude Code and the panel can read.
 */
export class MemoryEngine {
  readonly store: MemoryStore;
  readonly episodes: EpisodeLog;
  readonly events = new Emitter<MemoryEvent>();
  private cursor: CursorFile;
  private queue = new SerialQueue();
  private lastEpisodeAt = 0;
  private lastLlmAt = 0;
  private exportDirty = true;
  private pendingCorrection = false;
  private clock: () => number;
  private home: string;
  private lastResult: ReflectionResult | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: EngineDeps) {
    this.clock = deps.clock ?? Date.now;
    this.home = deps.home ?? os.homedir();
    this.store = new MemoryStore(deps.paths, this.clock);
    this.cursor = new CursorFile(deps.paths.memoryCursor);
    this.episodes = new EpisodeLog(deps.paths, this.clock, this.cursor.read().reflectedSeq);
    if (!fs.existsSync(deps.paths.memoryPolicy)) writeFileAtomic(deps.paths.memoryPolicy, DEFAULT_POLICY, 0o600);
    this.store.onChange.on(() => {
      this.exportDirty = true;
    });
    this.refreshViews();
  }

  private get cfg() {
    return this.deps.config.get();
  }

  get enabled(): boolean {
    return this.cfg.memory.enabled;
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------ observation

  observe(input: EpisodeInput): Episode | null {
    if (!this.enabled) return null;
    const ep = this.episodes.append(input);
    if (ep) {
      this.lastEpisodeAt = this.clock();
      const corrected = ep.t === 'ext' ? ep.correction : false;
      // Something the user explicitly told an agent to always/never do is worth learning now, not after more activity piles up.
      const userText = ep.t === 'ext' && ep.role === 'user' ? ep.text : '';
      if (corrected || (userText && extractDirectives(userText).length > 0)) this.pendingCorrection = true;
    }
    return ep;
  }

  observeCommand(c: { cmd: string; exit: number | null; cwd?: string; project?: string; durMs?: number; branch?: string; out?: string }): Episode | null {
    if (isSensitiveCommand(c.cmd)) return null;
    // Only failures keep an output tail.
    const keepOut = c.exit !== 0;
    const ep: Omit<CommandEpisode, 'seq' | 'id' | 'ts'> = { t: 'cmd', cmd: c.cmd, exit: c.exit, cwd: c.cwd, project: c.project, durMs: c.durMs, branch: c.branch, out: keepOut ? c.out : undefined };
    return this.observe(ep);
  }

  // ------------------------------------------------------------ explicit memory (user / agents)

  remember(text: string, opts: { kind?: MemoryKind; scope?: MemoryScope; source?: 'user' | 'agent'; tags?: string[]; pinned?: boolean } = {}): { item: MemoryItem; deduped: boolean } | { error: string } {
    const source = opts.source ?? 'user';
    const run = this.store.newRun(source, 'explicit remember');
    const kind = opts.kind && MEMORY_KINDS.includes(opts.kind) ? opts.kind : this.guessKind(text);
    const res = this.store.add(run, { kind, scope: opts.scope ?? 'global', text, tags: opts.tags, confidence: source === 'user' ? 0.9 : 0.7, pinned: opts.pinned });
    if (!res) return { error: 'Could not store that (too short, or it looks like it contains a secret).' };
    this.store.flush();
    this.refreshViews();
    this.events.emit({ type: 'learned', items: [res.item] });
    this.events.emit({ type: 'updated', reason: 'remember' });
    return res;
  }

  private guessKind(text: string): MemoryKind {
    const t = text.toLowerCase();
    if (/\b(never|don'?t|do not|avoid|stop)\b/.test(t)) return 'lesson';
    if (/\b(prefer|like|always|favorite|use)\b/.test(t)) return 'preference';
    if (/\b(run|build|test|deploy|command)\b/.test(t)) return 'workflow';
    return 'fact';
  }

  /**
   * Forget a memory by its id, or by describing it. A description only counts when the best match really reads like it (a ranking's
   * best hit is always "100 %" of itself, so ranking alone proves nothing), and never matches a pinned memory. An agent
   * (the MCP tool) may not forget a pinned memory even by its id: that is the person's call.
   */
  forget(idOrQuery: string, opts: { agent?: boolean } = {}): { archived: MemoryItem[]; refused?: 'pinned' } {
    const agent = !!opts.agent;
    const run = this.store.newRun(agent ? 'agent' : 'user', 'forget');
    const direct = this.store.getItem(idOrQuery);
    let target: MemoryItem | undefined;
    let refused: 'pinned' | undefined;
    if (direct) {
      if (direct.pinned && agent) refused = 'pinned';
      else target = direct;
    } else {
      const best = rankItems(this.store.listItems().filter((i) => !i.pinned), { query: idOrQuery })[0];
      if (best && best.relevance > 0 && similarity(idOrQuery, best.item.text) >= 0.5) target = best.item;
    }
    const archived: MemoryItem[] = [];
    const a = target && this.store.archive(run, target.id);
    if (a) archived.push(a);
    this.store.flush();
    this.refreshViews();
    if (archived.length) this.events.emit({ type: 'updated', reason: 'forget' });
    return refused ? { archived, refused } : { archived };
  }

  recall(query: string, opts: { cwd?: string; limit?: number } = {}): RecallResult {
    const limit = opts.limit ?? 8;
    const items = rankItems(this.store.listItems(), { cwd: opts.cwd, query })
      .filter((r) => r.relevance > 0)
      .slice(0, limit);
    const skills = rankSkills(this.store.listSkills(), { cwd: opts.cwd, query })
      .filter((r) => r.score > 0.3)
      .slice(0, 4);
    this.store.markUsed(items.map((r) => r.item.id));
    for (const s of skills) this.store.markSkillUsed(s.skill.id);
    this.store.flush();
    return { items: items.map((r) => ({ ...r.item, score: r.score })), skills: skills.map((s) => ({ ...s.skill, score: s.score })) };
  }

  context(opts: ContextOptions = {}): BuiltContext {
    const ctx = buildContext(this.store, { home: this.home, ...opts });
    if (ctx.itemIds.length) this.store.markUsed(ctx.itemIds);
    return ctx;
  }

  // ------------------------------------------------------------ reflection

  private llmClient(): LlmClient | null {
    if (this.cfg.memory.llm === 'off' || !this.cfg.onboarded) return null;
    try {
      return this.deps.llm?.() ?? null;
    } catch {
      return null;
    }
  }

  reflect(opts: { force?: boolean; llm?: boolean } = {}): Promise<ReflectionResult> {
    return this.queue.run(() => this.doReflect(opts));
  }

  private async doReflect(opts: { force?: boolean; llm?: boolean }): Promise<ReflectionResult> {
    const state = this.cursor.read();
    const episodes = this.episodes.readAfter(state.reflectedSeq);
    // Take the "learn this soon" flag together with the episodes it refers to. Clearing it after the (slow) model call would
    // also wipe the flag of a rule observed meanwhile, which is not in this pass and would then wait for more activity.
    const hadCorrection = this.pendingCorrection;
    this.pendingCorrection = false;
    const run: RunCtx = this.store.newRun('heuristic', 'reflection');
    const counts: ApplyCounts = emptyCounts();
    let mode: ReflectionResult['mode'] = 'heuristic';
    let error: string | undefined;
    const lines: string[] = [];

    // 1. offline rules — always
    const heur = runHeuristics({ episodes, candidates: state.candidates, now: this.clock(), env: this.deps.env ?? this.defaultEnv() });
    const hc = applyOps(this.store, { ...run, source: 'heuristic' }, heur.ops, { maxOps: 40 });
    add(counts, hc);

    // 2. model-assisted curation — when permitted and due
    const llm = opts.llm === false ? null : this.llmClient();
    const due = opts.force || hadCorrection || this.clock() - this.lastLlmAt >= this.cfg.memory.llmMinIntervalSec * 1000;
    if (llm && due && episodes.length > 0) {
      try {
        const r = await reflectWithLlm({ llm, store: this.store, episodes, policy: this.readPolicy(), model: this.cfg.memory.reflectorModel });
        const lc = applyOps(this.store, { ...run, source: 'reflector' }, r.ops, { maxOps: 12 });
        add(counts, lc);
        mode = 'both';
        this.lastLlmAt = this.clock();
        if (r.dropped) lines.push(`${r.dropped} malformed op(s) ignored`);
      } catch (e) {
        error = errMsg(e);
      }
    }

    if (error) this.pendingCorrection ||= hadCorrection; // the model did not get to look at it: try again soon

    const maxSeq = episodes.length ? Math.max(...episodes.map((e) => e.seq)) : state.reflectedSeq;
    this.cursor.update((c) => {
      c.reflectedSeq = Math.max(c.reflectedSeq, maxSeq);
      c.candidates = heur.candidates;
      c.lastReflectionAt = nowIso();
    });
    this.store.flush();
    this.refreshViews();

    const result: ReflectionResult = {
      runId: run.runId,
      ts: nowIso(),
      mode,
      episodes: episodes.length,
      ...counts,
      summary: summarize(counts, episodes.length, mode, lines),
      error,
    };
    this.lastResult = result;
    this.events.emit({ type: 'reflection', result });
    if (counts.applied > 0) this.events.emit({ type: 'updated', reason: 'reflection' });
    return result;
  }

  consolidate(): Promise<ReflectionResult> {
    return this.queue.run(async () => {
      const run = this.store.newRun('consolidator', 'consolidation');
      this.store.backupDaily();
      const c = consolidateHeuristic(this.store, run);
      let llmCounts = emptyCounts();
      const llm = this.llmClient();
      if (llm && this.store.listItems().length > 20) {
        try {
          const r = await reflectWithLlm({
            llm,
            store: this.store,
            episodes: [],
            policy: this.readPolicy(),
            model: this.cfg.memory.reflectorModel,
            focus: 'This is a consolidation pass with no new activity. Merge duplicates, tighten wording, and forget obsolete or low-value items. Do not add new knowledge.',
          });
          llmCounts = applyOps(this.store, { ...run, source: 'consolidator' }, r.ops.filter((o) => o.op !== 'add' && o.op !== 'skill'), { maxOps: 12 });
        } catch {
          /* heuristic result stands */
        }
      }
      this.episodes.prune(this.cfg.memory.retentionDays);
      this.cursor.update((s) => {
        s.lastConsolidationAt = nowIso();
      });
      this.store.flush();
      this.refreshViews();
      const res: ReflectionResult = {
        runId: run.runId,
        ts: nowIso(),
        mode: 'consolidate',
        episodes: 0,
        applied: c.merged + c.archived + c.capped + llmCounts.applied,
        skipped: llmCounts.skipped,
        added: 0,
        updated: c.merged + llmCounts.updated,
        reinforced: 0,
        archived: c.archived + c.capped + llmCounts.archived,
        skills: 0,
        summary: `Consolidated: merged ${c.merged}, archived ${c.archived + c.capped}${llmCounts.applied ? `, model tidied ${llmCounts.applied}` : ''}.`,
      };
      this.events.emit({ type: 'reflection', result: res });
      if (res.applied) this.events.emit({ type: 'updated', reason: 'consolidation' });
      return res;
    });
  }

  /** Periodic housekeeping: decide whether reflection / consolidation / export are due. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const state = this.cursor.read();
    const pending = this.episodes.pending(state.reflectedSeq);
    const idleMs = this.clock() - this.lastEpisodeAt;
    const c = this.cfg.memory;
    if (pending >= c.reflectEveryN || (pending >= 3 && idleMs >= c.idleSeconds * 1000) || (this.pendingCorrection && pending > 0)) {
      await this.reflect();
    }
    const lastCons = state.lastConsolidationAt ? Date.parse(state.lastConsolidationAt) : 0;
    if (this.clock() - lastCons > 24 * 3_600_000 && idleMs > 60_000 && this.store.listItems().length > 0) await this.consolidate();
    if (this.exportDirty) this.syncExports();
  }

  private readPolicy(): string {
    try {
      return fs.readFileSync(this.deps.paths.memoryPolicy, 'utf8');
    } catch {
      return DEFAULT_POLICY;
    }
  }

  private defaultEnv(): HeuristicEnv {
    return { platform: process.platform, arch: process.arch, shell: process.env.SHELL, osRelease: os.release(), home: this.home };
  }

  refreshViews(): void {
    try {
      writeViews(this.store, this.home);
    } catch {
      /* views are best-effort */
    }
  }

  /** Push memory to Claude Code if the user opted in (the CLAUDE.md block, Claude skills). */
  syncExports(): void {
    this.exportDirty = false;
    if (!this.cfg.onboarded) return;
    try {
      syncExports(this.store, this.cfg.export.targets, this.home);
      syncClaudeSkills(this.store, this.cfg.export.claudeSkills, this.home);
    } catch {
      /* never let an export failure disturb the session */
    }
  }

  // ------------------------------------------------------------ introspection

  stats(): MemoryStats {
    const s = this.store.stats();
    const state = this.cursor.read();
    return {
      ...s,
      episodesPending: this.episodes.pending(state.reflectedSeq),
      lastReflection: this.lastResult,
      lastConsolidation: state.lastConsolidationAt,
    };
  }

  cursorState(): CursorState {
    return this.cursor.read();
  }

  updateCursor(fn: (c: CursorState) => void): void {
    this.cursor.update(fn);
  }
}

function add(a: ApplyCounts, b: ApplyCounts): void {
  a.applied += b.applied;
  a.skipped += b.skipped;
  a.added += b.added;
  a.updated += b.updated;
  a.reinforced += b.reinforced;
  a.archived += b.archived;
  a.skills += b.skills;
}

function summarize(c: ApplyCounts, episodes: number, mode: string, notes: string[]): string {
  if (episodes === 0 && c.applied === 0) return 'Nothing new to learn.';
  const parts: string[] = [];
  if (c.added) parts.push(`learned ${c.added}`);
  if (c.reinforced) parts.push(`reinforced ${c.reinforced}`);
  if (c.updated) parts.push(`refined ${c.updated}`);
  if (c.archived) parts.push(`let go of ${c.archived}`);
  if (c.skills) parts.push(`${c.skills} skill${c.skills > 1 ? 's' : ''}`);
  const body = parts.length ? parts.join(', ') : 'no changes';
  return `Reviewed ${episodes} event${episodes === 1 ? '' : 's'} (${mode}): ${body}.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`;
}
