import { describe, expect, it } from 'vitest';
import { memoryToast } from '../src/shared/memory-toast';
import type { ReflectionResult } from '../src/core/memory/types';

const run = (over: Partial<ReflectionResult> = {}): ReflectionResult => ({ runId: 'r1', ts: '2026-10-07T10:00:00Z', mode: 'both', episodes: 4, applied: 1, skipped: 0, added: 0, updated: 0, reinforced: 0, archived: 0, skills: 0, summary: 'Reviewed 4 events (both): reinforced 1.', ...over });

describe('memoryToast: only tell the person what is worth interrupting them for', () => {
  it('says nothing for housekeeping: something already known was seen again, nothing new was looked at, memory faded or was tidied', () => {
    expect(memoryToast({ type: 'reflection', result: run({ reinforced: 1 }) })).toBeNull(); // "Reviewed 4 events (both): reinforced 1."
    expect(memoryToast({ type: 'reflection', result: run({ episodes: 0, mode: 'heuristic', reinforced: 1 }) })).toBeNull(); // "Reviewed 0 events…"
    expect(memoryToast({ type: 'reflection', result: run({ archived: 2, applied: 2 }) })).toBeNull();
    expect(memoryToast({ type: 'reflection', result: run({ mode: 'consolidate', added: 0, updated: 0, applied: 3, summary: 'Consolidated: merged 2' }) })).toBeNull();
    expect(memoryToast({ type: 'reflection', result: run({ applied: 0 }) })).toBeNull();
    expect(memoryToast({ type: 'reflection' })).toBeNull();
    expect(memoryToast({ type: 'something-else' })).toBeNull();
  });

  it('says what it learned, in plain words, with an undo for that run', () => {
    expect(memoryToast({ type: 'reflection', result: run({ added: 1 }) })).toEqual({ text: 'Jaffer learned something new', undo: { kind: 'revert', runId: 'r1' } });
    expect(memoryToast({ type: 'reflection', result: run({ added: 2, updated: 1 }) })).toEqual({ text: 'Jaffer learned 3 new things', undo: { kind: 'revert', runId: 'r1' } });
    expect(memoryToast({ type: 'reflection', result: run({ updated: 1 }) })!.text).toBe('Jaffer learned something new');
  });

  it('a memory the person asked for ("remember …") is confirmed with its text', () => {
    expect(memoryToast({ type: 'learned', items: [{ id: 'm1', text: 'Prefer pnpm' }] })).toEqual({ text: 'Remembered: Prefer pnpm', undo: { kind: 'forget', id: 'm1' } });
    expect(memoryToast({ type: 'learned', items: [] })).toBeNull();
  });
});
