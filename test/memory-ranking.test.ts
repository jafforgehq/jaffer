import { describe, expect, it } from 'vitest';
import { ageDays, effectiveConfidence, isInside, projectOfScope, rankItems, rankSkills, scopeWeight, strength } from '../src/core/memory/ranking';
import type { MemoryItem, SkillItem } from '../src/core/memory/types';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const item = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'm1', kind: 'preference', scope: 'global', text: 'Prefers pnpm', tags: [], confidence: 0.8, evidence: 1, uses: 0, contradictions: 0,
  pinned: false, status: 'active', source: 'user', createdAt: ago(0), updatedAt: ago(0), lastSeenAt: ago(0), ...over,
});
const skill = (over: Partial<SkillItem> = {}): SkillItem => ({
  id: 's1', name: 'Ship a release', description: 'cut a release', whenToUse: 'when asked to release', steps: ['npm version patch'], scope: 'global',
  confidence: 0.7, evidence: 1, uses: 0, pinned: false, status: 'active', source: 'heuristic', createdAt: ago(0), updatedAt: ago(0), lastSeenAt: ago(0), ...over,
});

describe('ageDays', () => {
  it('is the days since a time, never negative, and 0 for a time it cannot read', () => {
    expect(ageDays(ago(10), NOW)).toBeCloseTo(10, 6);
    expect(ageDays(ago(-5), NOW)).toBe(0); // in the future
    expect(ageDays('not a date', NOW)).toBe(0);
  });
});

describe('effectiveConfidence', () => {
  it('halves after one half-life of not being seen, by kind (a project note fades faster than a fact)', () => {
    expect(effectiveConfidence(item({ kind: 'project', confidence: 0.8, lastSeenAt: ago(45) }), NOW)).toBeCloseTo(0.4, 6);
    expect(effectiveConfidence(item({ kind: 'fact', confidence: 0.8, lastSeenAt: ago(365) }), NOW)).toBeCloseTo(0.4, 6);
    expect(effectiveConfidence(item({ kind: 'preference', confidence: 0.8, lastSeenAt: ago(45) }), NOW)).toBeGreaterThan(effectiveConfidence(item({ kind: 'project', confidence: 0.8, lastSeenAt: ago(45) }), NOW));
  });

  it('does not decay what was seen today, and never drops below zero or rises above its confidence', () => {
    expect(effectiveConfidence(item({ confidence: 0.6 }), NOW)).toBeCloseTo(0.6, 6);
    expect(effectiveConfidence(item({ confidence: 0.6, lastSeenAt: ago(5000) }), NOW)).toBeGreaterThanOrEqual(0);
  });

  it('a pinned item never fades, and counts as at least 0.9', () => {
    expect(effectiveConfidence(item({ pinned: true, confidence: 0.3, lastSeenAt: ago(2000) }), NOW)).toBe(0.9);
    expect(effectiveConfidence(item({ pinned: true, confidence: 0.99, lastSeenAt: ago(2000) }), NOW)).toBe(0.99);
  });
});

describe('strength', () => {
  it('grows with evidence and with being recalled on purpose, and a pin is worth half again', () => {
    const base = strength(item(), NOW);
    expect(strength(item({ evidence: 8 }), NOW)).toBeGreaterThan(base);
    expect(strength(item({ uses: 4 }), NOW)).toBeGreaterThan(base);
    expect(strength(item({ pinned: true, confidence: 0.8 }), NOW)).toBeGreaterThan(base * 1.5);
  });

  it('each contradiction takes it down', () => {
    const base = strength(item(), NOW);
    expect(strength(item({ contradictions: 1 }), NOW)).toBeCloseTo(base / 1.5, 6);
    expect(strength(item({ contradictions: 2 }), NOW)).toBeCloseTo(base / 2, 6);
  });
});

describe('scopes', () => {
  it('reads the project out of a scope', () => {
    expect(projectOfScope('project:/work/api')).toBe('/work/api');
    expect(projectOfScope('global')).toBeNull();
  });

  it('inside means the same folder or below it, and a folder that merely starts with the same letters is not inside', () => {
    expect(isInside('/work/api', '/work/api')).toBe(true);
    expect(isInside('/work/api/src/auth', '/work/api')).toBe(true);
    expect(isInside('/work/api/', '/work/api')).toBe(true);
    expect(isInside('/work/api-gateway', '/work/api')).toBe(false);
    expect(isInside('/work', '/work/api')).toBe(false);
    expect(isInside('', '/work/api')).toBe(false);
    expect(isInside('/work/api', '')).toBe(false);
  });

  it('global notes always apply; a project note applies fully inside its project and barely anywhere else', () => {
    expect(scopeWeight('global', undefined)).toBe(1);
    expect(scopeWeight('project:/work/api', '/work/api/src')).toBe(1.4);
    expect(scopeWeight('project:/work/api', '/work/web')).toBe(0.2);
    expect(scopeWeight('project:/work/api', undefined)).toBe(0.2);
  });
});

describe('rankItems', () => {
  it('puts what matches the query first, and keeps strength for the rest', () => {
    const items = [
      item({ id: 'a', text: 'Deploys go through the release script', confidence: 0.9 }),
      item({ id: 'b', text: 'Prefers pnpm over npm', confidence: 0.6 }),
    ];
    expect(rankItems(items, { now: NOW }).map((r) => r.item.id)).toEqual(['a', 'b']);
    const asked = rankItems(items, { now: NOW, query: 'pnpm' });
    expect(asked.map((r) => r.item.id)).toEqual(['b', 'a']);
    expect(asked[0]!.relevance).toBe(1);
    expect(asked[1]!.relevance).toBe(0);
  });

  it('prefers the notes of the project being worked on', () => {
    const items = [
      item({ id: 'other', scope: 'project:/work/web', text: 'Components live in src/ui', confidence: 0.9 }),
      item({ id: 'here', scope: 'project:/work/api', text: 'Handlers live in src/routes', confidence: 0.6 }),
    ];
    expect(rankItems(items, { now: NOW, cwd: '/work/api/src' })[0]!.item.id).toBe('here');
    expect(rankItems(items, { now: NOW, cwd: '/work/web' })[0]!.item.id).toBe('other');
  });

  it('copes with no items, and with a query that matches nothing', () => {
    expect(rankItems([], { query: 'x' })).toEqual([]);
    expect(rankItems([item()], { now: NOW, query: 'zzzz' })[0]!.relevance).toBe(0);
  });
});

describe('rankSkills', () => {
  it('matches the query on name, description, trigger and steps, and fades what is not pinned', () => {
    const skills = [skill({ id: 'rel', name: 'Ship a release', steps: ['npm version patch'] }), skill({ id: 'db', name: 'Reset the dev database', whenToUse: 'when seeds are stale', steps: ['make db-reset'] })];
    expect(rankSkills(skills, { now: NOW, query: 'database seeds' })[0]!.skill.id).toBe('db');
    expect(rankSkills(skills, { now: NOW, query: 'npm version' })[0]!.skill.id).toBe('rel');
    const old = rankSkills([skill({ lastSeenAt: ago(120) })], { now: NOW })[0]!.score;
    const fresh = rankSkills([skill()], { now: NOW })[0]!.score;
    expect(old).toBeCloseTo(fresh / 2, 6);
    expect(rankSkills([skill({ lastSeenAt: ago(1000), pinned: true })], { now: NOW })[0]!.score).toBeCloseTo(fresh, 6);
  });
});
