import type { MemoryItem, MemoryKind, MemoryScope, SkillItem } from './types';
import { bm25 } from './text';

const DAY = 86_400_000;

/** How quickly an unreinforced memory of each kind loses relevance (half-life in days). */
export const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  preference: 240,
  convention: 150,
  fact: 365,
  workflow: 90,
  lesson: 120,
  project: 45,
  environment: 180,
};

export function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / DAY);
}

/** Confidence after time-decay. Pinned items never decay. */
export function effectiveConfidence(item: MemoryItem, now: number = Date.now()): number {
  if (item.pinned) return Math.max(item.confidence, 0.9);
  const hl = HALF_LIFE_DAYS[item.kind] ?? 120;
  return item.confidence * Math.pow(0.5, ageDays(item.lastSeenAt, now) / hl);
}

/** Intrinsic value of an item ignoring any query: confidence x decay x how often it proved useful. */
export function strength(item: MemoryItem, now: number = Date.now()): number {
  const usage = 1 + 0.25 * Math.log1p(item.evidence + item.uses * 2);
  const pin = item.pinned ? 1.5 : 1;
  const penalty = item.contradictions > 0 ? 1 / (1 + item.contradictions * 0.5) : 1;
  return effectiveConfidence(item, now) * usage * pin * penalty;
}

export function projectOfScope(scope: MemoryScope): string | null {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : null;
}

export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const a = child.endsWith('/') ? child : child + '/';
  const b = parent.endsWith('/') ? parent : parent + '/';
  return a.startsWith(b);
}

/** How relevant a scope is to where the user is working right now. */
export function scopeWeight(scope: MemoryScope, cwd: string | undefined): number {
  const p = projectOfScope(scope);
  if (p === null) return 1;
  if (cwd && isInside(cwd, p)) return 1.4;
  return 0.2;
}

export interface RankContext {
  cwd?: string;
  query?: string;
  now?: number;
}

export interface RankedItem {
  item: MemoryItem;
  score: number;
  relevance: number;
}

export function rankItems(items: MemoryItem[], ctx: RankContext = {}): RankedItem[] {
  const now = ctx.now ?? Date.now();
  const rel = new Map<string, number>();
  if (ctx.query && ctx.query.trim()) {
    const hits = bm25(
      items.map((i) => ({ id: i.id, text: `${i.text} ${i.tags.join(' ')} ${i.kind}` })),
      ctx.query,
    );
    const max = hits[0]?.score ?? 0;
    if (max > 0) for (const h of hits) rel.set(h.id, h.score / max);
  }
  const out = items.map((item) => {
    const relevance = rel.get(item.id) ?? 0;
    const score = strength(item, now) * scopeWeight(item.scope, ctx.cwd) * (1 + 2 * relevance);
    return { item, score, relevance };
  });
  return out.sort((a, b) => b.score - a.score);
}

export function rankSkills(skills: SkillItem[], ctx: RankContext = {}): { skill: SkillItem; score: number }[] {
  const now = ctx.now ?? Date.now();
  const rel = new Map<string, number>();
  if (ctx.query && ctx.query.trim()) {
    const hits = bm25(
      skills.map((s) => ({ id: s.id, text: `${s.name} ${s.description} ${s.whenToUse} ${s.steps.join(' ')}` })),
      ctx.query,
    );
    const max = hits[0]?.score ?? 0;
    if (max > 0) for (const h of hits) rel.set(h.id, h.score / max);
  }
  return skills
    .map((skill) => {
      const decay = skill.pinned ? 1 : Math.pow(0.5, ageDays(skill.lastSeenAt, now) / 120);
      const base = skill.confidence * decay * (1 + 0.25 * Math.log1p(skill.evidence + skill.uses * 2));
      return { skill, score: base * scopeWeight(skill.scope, ctx.cwd) * (1 + 2 * (rel.get(skill.id) ?? 0)) };
    })
    .sort((a, b) => b.score - a.score);
}
