import { describe, expect, it } from 'vitest';
import { EFFORT_STEPS_MS, effortLevel, longestRunning } from '../src/shared/pet-effort';

describe('effortLevel: the longer something works, the harder its mole works', () => {
  it('starts calm and steps up at half a minute, two minutes and five minutes', () => {
    expect(EFFORT_STEPS_MS).toEqual([30_000, 120_000, 300_000]);
    expect(effortLevel(0)).toBe(0);
    expect(effortLevel(29_999)).toBe(0);
    expect(effortLevel(30_000)).toBe(1);
    expect(effortLevel(119_999)).toBe(1);
    expect(effortLevel(120_000)).toBe(2);
    expect(effortLevel(299_999)).toBe(2);
    expect(effortLevel(300_000)).toBe(3);
    expect(effortLevel(6 * 3600_000)).toBe(3);
  });
  it('treats a missing or odd duration as fresh (a clock that jumped back, no start time)', () => {
    expect(effortLevel(undefined)).toBe(0);
    expect(effortLevel(-5_000)).toBe(0);
    expect(effortLevel(Number.NaN)).toBe(0);
  });
});

describe('longestRunning: how long the oldest thing in a list has been going', () => {
  it('is measured from the earliest start, ignoring what has no start', () => {
    expect(longestRunning([10_000, 40_000, undefined], 100_000)).toBe(90_000);
    expect(longestRunning([], 100_000)).toBeUndefined();
    expect(longestRunning([undefined], 100_000)).toBeUndefined();
  });
});
