import { describe, expect, it } from 'vitest';
import { TIP_GAP_MS, TIPS, shouldTip, type TipId } from '../src/shared/tips';
import { glossaryEntry } from '../src/shared/glossary';

const on = { enabled: true, seen: [] as string[] };
const free = { now: 1_000_000, lastAt: 0, busy: false, away: false };

describe('first-time tips (1.4.0)', () => {
  it('six tips, each a one-sentence "What is …?" teaser that names a glossary entry', () => {
    expect(Object.keys(TIPS).sort()).toEqual(['budget', 'compaction', 'context', 'longturn', 'permission', 'subagent']);
    for (const [id, t] of Object.entries(TIPS)) {
      expect(glossaryEntry(t.glossary), id).toBeDefined();
      expect(t.text, id).toMatch(/What (is|are) [^?]+\?$/);
      expect(t.text.length, id).toBeLessThanOrEqual(120);
    }
    expect(TIPS.compaction.glossary).toBe('compaction');
    expect(TIPS.permission.glossary).toBe('permission-prompt');
    expect(TIPS.context.glossary).toBe('context-window');
    expect(TIPS.budget.glossary).toBe('cost-estimate');
    expect(TIPS.context.text).toMatch(/about 80% full/);
  });

  it('a tip shows once ever: not when its id is in tips.seen, nor with tips off, nor for an unknown id', () => {
    expect(shouldTip('compaction', on, free)).toBe(true);
    expect(shouldTip('compaction', { enabled: true, seen: ['compaction'] }, free)).toBe(false);
    expect(shouldTip('subagent', { enabled: true, seen: ['compaction'] }, free)).toBe(true);
    expect(shouldTip('compaction', { enabled: false, seen: [] }, free)).toBe(false);
    expect(shouldTip('nope' as TipId, on, free)).toBe(false);
    expect(shouldTip('compaction', undefined, free)).toBe(false); // (no config yet: nothing)
  });

  it('at most one tip in 90 s, and none while first run or the tour is up, or while the window is away', () => {
    expect(TIP_GAP_MS).toBe(90_000);
    expect(shouldTip('compaction', on, { ...free, lastAt: free.now - 89_999 })).toBe(false);
    expect(shouldTip('compaction', on, { ...free, lastAt: free.now - 90_000 })).toBe(true);
    expect(shouldTip('compaction', on, { ...free, busy: true })).toBe(false);
    expect(shouldTip('compaction', on, { ...free, away: true })).toBe(false); // (the window not focused or not visible: nobody would see it)
  });
});
