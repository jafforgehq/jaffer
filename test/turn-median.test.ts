import { describe, expect, it } from 'vitest';
import { nextTypicalTurnMs } from '../src/shared/turn-median';

describe('nextTypicalTurnMs: how long a turn of Claude typically takes (the ring fills against it)', () => {
  it('the first turn is the typical one', () => {
    expect(nextTypicalTurnMs(0, 42_000, [])).toBe(42_000);
  });

  it('is the median of the last turns, so one very long turn does not move it far', () => {
    const recent: number[] = [];
    let typical = 0;
    for (const ms of [10_000, 20_000, 30_000, 600_000]) typical = nextTypicalTurnMs(typical, ms, recent);
    expect(typical).toBe(25_000); // (20 s + 30 s) / 2
    typical = nextTypicalTurnMs(typical, 12_000, recent);
    expect(typical).toBe(20_000);
  });

  it('keeps only the last 15 turns', () => {
    const recent: number[] = [];
    let typical = 0;
    for (let i = 0; i < 15; i++) typical = nextTypicalTurnMs(typical, 100_000, recent);
    for (let i = 0; i < 15; i++) typical = nextTypicalTurnMs(typical, 5_000, recent);
    expect(typical).toBe(5_000);
    expect(recent).toHaveLength(15);
  });

  it('ignores turns under 3 s (a quick answer says nothing about a working turn)', () => {
    const recent: number[] = [];
    expect(nextTypicalTurnMs(30_000, 2_999, recent)).toBe(30_000);
    expect(recent).toEqual([]);
    expect(nextTypicalTurnMs(0, 1_000, recent)).toBe(0); // and none yet stays none
  });

  it('after a restart the stored value counts as one turn (the memory of the last turns is gone)', () => {
    const recent: number[] = [];
    expect(nextTypicalTurnMs(60_000, 20_000, recent)).toBe(40_000);
    expect(recent).toEqual([60_000, 20_000]);
  });
});
