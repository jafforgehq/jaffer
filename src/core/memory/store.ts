import fs from 'node:fs';
import path from 'node:path';
import type { JafferPaths } from '../../shared/paths';
import { appendLine, dayKey, Emitter, ensureDir, readJsonl, uid, writeFileAtomic, writeJsonl } from '../../shared/util';
import { redact } from '../../shared/redact';
import type { JournalEntry, JournalOp, MemoryItem, MemoryKind, MemoryScope, MemorySource, SkillItem } from './types';
import { MEMORY_KINDS } from './types';
import { similarity } from './text';
import { effectiveConfidence, strength } from './ranking';

export const MAX_ITEM_CHARS = 320;
export const DEDUPE_THRESHOLD = 0.72;

export interface AddInput {
  kind: MemoryKind;
  scope: MemoryScope;
  text: string;
  tags?: string[];
  confidence?: number;
  key?: string;
  pinned?: boolean;
}

export interface AddSkillInput {
  name: string;
  description: string;
  whenToUse: string;
  steps: string[];
  scope?: MemoryScope;
  confidence?: number;
  key?: string;
  pinned?: boolean;
}

export interface RunCtx {
  runId: string;
  source: MemorySource;
  reason?: string;
}

export interface AddResult {
  item: MemoryItem;
  /** True when an equivalent item already existed and was reinforced instead of duplicated. */
  deduped: boolean;
}

export type StoreChange = { type: 'items' | 'skills' };

/**
 * Normalise memory text. Anything that looked like a secret is rejected outright (null) —
 * a note reading "use [REDACTED] for the API" is worthless, and rejecting is the safer default.
 */
function sanitize(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
  if (flat.length < 6) return null;
  if (redact(flat).count > 0) return null;
  return flat;
}

/** For names/steps of skills, where masking (rather than rejecting) is acceptable. */
function clean(text: string): string {
  return redact(text).text.replace(/\s+/g, ' ').trim();
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * The source of truth for long-term memory. Items and skills are held in memory and
 * persisted as JSONL; every mutation is journaled with before/after snapshots so any
 * reflection run can be inspected and reverted.
 */
export class MemoryStore {
  readonly onChange = new Emitter<StoreChange>();
  private items = new Map<string, MemoryItem>();
  private skills = new Map<string, SkillItem>();
  private dirty = { items: false, skills: false };
  private usedDirty = false;

  constructor(
    readonly paths: JafferPaths,
    private clock: () => number = Date.now,
  ) {
    ensureDir(paths.memoryDir);
    this.load();
  }

  // ------------------------------------------------------------ load / save

  load(): void {
    this.items.clear();
    this.skills.clear();
    for (const raw of readJsonl<MemoryItem>(this.paths.memoryItems)) {
      if (raw && raw.id && typeof raw.text === 'string') {
        this.items.set(raw.id, { ...({ tags: [], evidence: 1, uses: 0, contradictions: 0, pinned: false, status: 'active' } as Partial<MemoryItem>), ...raw });
      }
    }
    for (const raw of readJsonl<SkillItem>(this.paths.memorySkills)) {
      if (raw && raw.id && raw.name) {
        this.skills.set(raw.id, { ...({ steps: [], evidence: 1, uses: 0, pinned: false, status: 'active' } as Partial<SkillItem>), ...raw });
      }
    }
  }

  /** Persist whatever changed. Cheap enough to call after every mutation batch. */
  flush(): void {
    if (this.dirty.items || this.usedDirty) {
      writeJsonl(this.paths.memoryItems, [...this.items.values()]);
      this.dirty.items = false;
      this.usedDirty = false;
      this.onChange.emit({ type: 'items' });
    }
    if (this.dirty.skills) {
      writeJsonl(this.paths.memorySkills, [...this.skills.values()]);
      this.dirty.skills = false;
      this.onChange.emit({ type: 'skills' });
    }
  }

  /** Daily rolling backup of the raw files; cheap insurance against a bad reflection. */
  backupDaily(keep = 14): void {
    const dir = this.paths.memoryHistoryDir;
    ensureDir(dir);
    const day = dayKey(this.clock());
    for (const [src, name] of [
      [this.paths.memoryItems, 'items'],
      [this.paths.memorySkills, 'skills'],
    ] as const) {
      const dest = path.join(dir, `${name}-${day}.jsonl`);
      if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
    const files = fs.readdirSync(dir).sort();
    for (const name of ['items-', 'skills-']) {
      const mine = files.filter((f) => f.startsWith(name));
      for (const f of mine.slice(0, Math.max(0, mine.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  // ------------------------------------------------------------ queries

  now(): number {
    return this.clock();
  }

  newRun(source: MemorySource, reason?: string): RunCtx {
    return { runId: uid('run'), source, reason };
  }

  getItem(id: string): MemoryItem | undefined {
    return this.items.get(id);
  }

  findByKey(key: string): MemoryItem | undefined {
    for (const i of this.items.values()) if (i.key === key) return i;
    return undefined;
  }

  findSkillByKey(key: string): SkillItem | undefined {
    for (const s of this.skills.values()) if (s.key === key) return s;
    return undefined;
  }

  listItems(filter: { scope?: MemoryScope; kind?: MemoryKind; status?: MemoryItem['status'] | 'all'; pinned?: boolean } = {}): MemoryItem[] {
    const status = filter.status ?? 'active';
    return [...this.items.values()].filter(
      (i) =>
        (status === 'all' || i.status === status) &&
        (filter.scope === undefined || i.scope === filter.scope) &&
        (filter.kind === undefined || i.kind === filter.kind) &&
        (filter.pinned === undefined || i.pinned === filter.pinned),
    );
  }

  listSkills(status: SkillItem['status'] | 'all' = 'active'): SkillItem[] {
    return [...this.skills.values()].filter((s) => status === 'all' || s.status === status);
  }

  scopes(): MemoryScope[] {
    return [...new Set(this.listItems().map((i) => i.scope))];
  }

  /** Best near-duplicate of `text` among active items of the same scope. */
  findSimilar(text: string, scope: MemoryScope, threshold = DEDUPE_THRESHOLD, excludeId?: string): MemoryItem | undefined {
    let best: MemoryItem | undefined;
    let bestSim = threshold;
    for (const i of this.items.values()) {
      if (i.status !== 'active' || i.scope !== scope || i.id === excludeId) continue;
      const s = similarity(i.text, text);
      if (s >= bestSim) {
        best = i;
        bestSim = s;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ journal

  private journal(run: RunCtx, op: JournalOp, target: 'item' | 'skill', id: string, before: unknown, after: unknown): void {
    const entry: JournalEntry = { ts: new Date(this.clock()).toISOString(), runId: run.runId, op, target, id, before: before ?? null, after: after ?? null, reason: run.reason, source: run.source };
    appendLine(this.paths.memoryJournal, entry);
  }

  readJournal(limit = 200): JournalEntry[] {
    const all = readJsonl<JournalEntry>(this.paths.memoryJournal);
    return limit > 0 ? all.slice(-limit) : all;
  }

  // ------------------------------------------------------------ item mutations

  add(run: RunCtx, input: AddInput): AddResult | null {
    const text = sanitize(input.text);
    if (!text) return null;
    if (!MEMORY_KINDS.includes(input.kind)) return null;
    const scope = input.scope || 'global';
    const dup = this.findSimilar(text, scope);
    if (dup) {
      const updated = this.reinforce(run, dup.id, run.source === 'user' ? text : undefined);
      return { item: updated ?? dup, deduped: true };
    }
    const now = new Date(this.clock()).toISOString();
    const item: MemoryItem = {
      id: uid('m'),
      key: input.key,
      kind: input.kind,
      scope,
      text,
      tags: (input.tags ?? []).map((t) => t.toLowerCase().slice(0, 24)).slice(0, 6),
      confidence: clamp01(input.confidence ?? (run.source === 'user' ? 0.85 : 0.6)),
      evidence: 1,
      uses: 0,
      contradictions: 0,
      pinned: input.pinned ?? false,
      status: 'active',
      source: run.source,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.items.set(item.id, item);
    this.journal(run, 'add', 'item', item.id, null, item);
    this.dirty.items = true;
    return { item, deduped: false };
  }

  /** Insert or update an item owned by a deterministic rule. Never resurrects items that were archived. */
  upsertByKey(run: RunCtx, key: string, input: Omit<AddInput, 'key'>): AddResult | null {
    const existing = this.findByKey(key);
    if (!existing) return this.add(run, { ...input, key });
    if (existing.status !== 'active') return null;
    const text = sanitize(input.text);
    if (!text) return null;
    if (text !== existing.text) {
      return { item: this.update(run, existing.id, { text }) ?? existing, deduped: false };
    }
    return { item: this.reinforce(run, existing.id) ?? existing, deduped: true };
  }

  update(run: RunCtx, id: string, patch: Partial<Pick<MemoryItem, 'text' | 'kind' | 'scope' | 'tags' | 'confidence'>>): MemoryItem | null {
    const cur = this.items.get(id);
    if (!cur) return null;
    const before = { ...cur };
    const next: MemoryItem = { ...cur, updatedAt: new Date(this.clock()).toISOString() };
    if (patch.text !== undefined) {
      const t = sanitize(patch.text);
      if (!t) return null;
      next.text = t;
    }
    if (patch.kind && MEMORY_KINDS.includes(patch.kind)) next.kind = patch.kind;
    if (patch.scope) next.scope = patch.scope;
    if (patch.tags) next.tags = patch.tags.map((x) => x.toLowerCase().slice(0, 24)).slice(0, 6);
    if (patch.confidence !== undefined) next.confidence = clamp01(patch.confidence);
    if (JSON.stringify(before) === JSON.stringify(next)) return cur;
    this.items.set(id, next);
    this.journal(run, 'update', 'item', id, before, next);
    this.dirty.items = true;
    return next;
  }

  reinforce(run: RunCtx, id: string, newText?: string): MemoryItem | null {
    const cur = this.items.get(id);
    if (!cur) return null;
    const before = { ...cur };
    const now = new Date(this.clock()).toISOString();
    const next: MemoryItem = {
      ...cur,
      confidence: clamp01(cur.confidence + (1 - cur.confidence) * 0.3),
      evidence: cur.evidence + 1,
      lastSeenAt: now,
      updatedAt: now,
      status: cur.status === 'archived' ? 'active' : cur.status,
    };
    if (newText) {
      const t = sanitize(newText);
      if (t) next.text = t;
    }
    this.items.set(id, next);
    this.journal(run, 'reinforce', 'item', id, before, next);
    this.dirty.items = true;
    return next;
  }

  contradict(run: RunCtx, id: string): MemoryItem | null {
    const cur = this.items.get(id);
    if (!cur || cur.pinned) return cur ?? null;
    const before = { ...cur };
    const next: MemoryItem = { ...cur, confidence: cur.confidence * 0.55, contradictions: cur.contradictions + 1, updatedAt: new Date(this.clock()).toISOString() };
    if (next.confidence < 0.2) next.status = 'archived';
    this.items.set(id, next);
    this.journal(run, 'contradict', 'item', id, before, next);
    this.dirty.items = true;
    return next;
  }

  archive(run: RunCtx, id: string): MemoryItem | null {
    const cur = this.items.get(id);
    if (!cur || cur.status === 'archived') return cur ?? null;
    const before = { ...cur };
    const next: MemoryItem = { ...cur, status: 'archived', updatedAt: new Date(this.clock()).toISOString() };
    this.items.set(id, next);
    this.journal(run, 'archive', 'item', id, before, next);
    this.dirty.items = true;
    return next;
  }

  pin(run: RunCtx, id: string, pinned: boolean): MemoryItem | null {
    const cur = this.items.get(id);
    if (!cur) return null;
    const before = { ...cur };
    const next: MemoryItem = { ...cur, pinned, status: 'active', updatedAt: new Date(this.clock()).toISOString() };
    this.items.set(id, next);
    this.journal(run, 'pin', 'item', id, before, next);
    this.dirty.items = true;
    return next;
  }

  /** Merge several items into one new item; the originals are kept as `superseded` for audit/revert. */
  merge(run: RunCtx, ids: string[], text: string, opts: { kind?: MemoryKind; scope?: MemoryScope } = {}): MemoryItem | null {
    const parts = ids.map((id) => this.items.get(id)).filter((x): x is MemoryItem => !!x && x.status === 'active');
    if (parts.length < 2) return null;
    const t = sanitize(text);
    if (!t) return null;
    const now = new Date(this.clock()).toISOString();
    const first = parts[0]!;
    const merged: MemoryItem = {
      id: uid('m'),
      kind: opts.kind && MEMORY_KINDS.includes(opts.kind) ? opts.kind : first.kind,
      scope: opts.scope ?? first.scope,
      text: t,
      tags: [...new Set(parts.flatMap((p) => p.tags))].slice(0, 6),
      confidence: clamp01(Math.max(...parts.map((p) => p.confidence)) + 0.05),
      evidence: parts.reduce((s, p) => s + p.evidence, 0),
      uses: parts.reduce((s, p) => s + p.uses, 0),
      contradictions: 0,
      pinned: parts.some((p) => p.pinned),
      status: 'active',
      source: run.source,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.items.set(merged.id, merged);
    this.journal(run, 'add', 'item', merged.id, null, merged);
    for (const p of parts) {
      const before = { ...p };
      const next: MemoryItem = { ...p, status: 'superseded', supersededBy: merged.id, updatedAt: now };
      this.items.set(p.id, next);
      this.journal(run, 'merge', 'item', p.id, before, next);
    }
    this.dirty.items = true;
    return merged;
  }

  /** Record that items were surfaced and used by an agent (cheap; not journaled). */
  markUsed(ids: string[]): void {
    const now = new Date(this.clock()).toISOString();
    for (const id of ids) {
      const cur = this.items.get(id);
      if (!cur) continue;
      this.items.set(id, { ...cur, uses: cur.uses + 1, lastSeenAt: now });
      this.usedDirty = true;
    }
  }

  // ------------------------------------------------------------ skills

  addSkill(run: RunCtx, input: AddSkillInput): SkillItem | null {
    const name = clean(input.name).slice(0, 60);
    const steps = input.steps.map((s) => clean(s).slice(0, 240)).filter(Boolean).slice(0, 12);
    if (!name || steps.length === 0) return null;
    // A skill whose commands needed masking is useless and risky: drop it.
    if (input.steps.some((s) => redact(s).count > 0)) return null;
    const description = clean(input.description).slice(0, 240);
    const whenToUse = clean(input.whenToUse).slice(0, 240);
    const scope = input.scope ?? 'global';
    // Same key or near-identical name+steps → reinforce instead of duplicating.
    const existing =
      (input.key ? this.findSkillByKey(input.key) : undefined) ??
      [...this.skills.values()].find((s) => s.status === 'active' && s.scope === scope && similarity(`${s.name} ${s.steps.join(' ')}`, `${name} ${steps.join(' ')}`) >= 0.8);
    const now = new Date(this.clock()).toISOString();
    if (existing) {
      if (existing.status !== 'active') return null;
      const before = { ...existing };
      const next: SkillItem = {
        ...existing,
        description: description || existing.description,
        whenToUse: whenToUse || existing.whenToUse,
        steps,
        confidence: clamp01(existing.confidence + (1 - existing.confidence) * 0.25),
        evidence: existing.evidence + 1,
        lastSeenAt: now,
        updatedAt: now,
      };
      this.skills.set(existing.id, next);
      this.journal(run, 'skill-update', 'skill', existing.id, before, next);
      this.dirty.skills = true;
      return next;
    }
    const skill: SkillItem = {
      id: uid('s'),
      key: input.key,
      name,
      description,
      whenToUse,
      steps,
      scope,
      confidence: clamp01(input.confidence ?? 0.55),
      evidence: 1,
      uses: 0,
      pinned: input.pinned ?? false,
      status: 'active',
      source: run.source,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.skills.set(skill.id, skill);
    this.journal(run, 'skill-add', 'skill', skill.id, null, skill);
    this.dirty.skills = true;
    return skill;
  }

  markSkillUsed(id: string): void {
    const cur = this.skills.get(id);
    if (!cur) return;
    this.skills.set(id, { ...cur, uses: cur.uses + 1, lastSeenAt: new Date(this.clock()).toISOString() });
    this.dirty.skills = true;
  }

  // ------------------------------------------------------------ revert

  /** Undo every mutation of a run, newest first. Returns the number of entries undone. */
  revertRun(runId: string, source: MemorySource = 'user'): number {
    const entries = this.readJournal(0).filter((e) => e.runId === runId);
    if (entries.length === 0) return 0;
    const already = this.readJournal(0).some((e) => e.reason === `revert of ${runId}`);
    if (already) return 0;
    const run: RunCtx = { runId: uid('run'), source, reason: `revert of ${runId}` };
    let n = 0;
    for (const e of entries.reverse()) {
      const map = (e.target === 'item' ? this.items : this.skills) as Map<string, MemoryItem | SkillItem>;
      const cur = map.get(e.id) ?? null;
      if (e.before === null) {
        if (cur) {
          map.delete(e.id);
          this.journal(run, 'delete', e.target, e.id, cur, null);
          n++;
        }
      } else {
        map.set(e.id, e.before as MemoryItem | SkillItem);
        this.journal(run, 'update', e.target, e.id, cur, e.before);
        n++;
      }
    }
    this.dirty.items = true;
    this.dirty.skills = true;
    this.flush();
    return n;
  }

  // ------------------------------------------------------------ housekeeping used by consolidation

  /** Items whose decayed strength fell below `floor` and that nothing protects. */
  fadedItems(floor = 0.08): MemoryItem[] {
    const now = this.clock();
    return this.listItems().filter((i) => !i.pinned && effectiveConfidence(i, now) < floor && strength(i, now) < floor * 1.5);
  }

  stats(): { active: number; archived: number; pinned: number; skills: number } {
    let active = 0;
    let archived = 0;
    let pinned = 0;
    for (const i of this.items.values()) {
      if (i.status === 'active') active++;
      else if (i.status === 'archived') archived++;
      if (i.pinned && i.status === 'active') pinned++;
    }
    return { active, archived, pinned, skills: this.listSkills().length };
  }

  /** Write a markdown file atomically (used by the renderers). */
  writeView(file: string, content: string): void {
    ensureDir(path.dirname(file));
    let prev = '';
    try {
      prev = fs.readFileSync(file, 'utf8');
    } catch {
      /* new file */
    }
    if (prev !== content) writeFileAtomic(file, content, 0o600);
  }
}
