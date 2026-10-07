import { describe, expect, it } from 'vitest';
import { crewMoods, crewSize, MAX_CREW } from '../src/shared/pet-crew';

describe('crewSize: one helper mole per running background agent, but a corner is only so wide', () => {
  it('counts them, up to a few', () => {
    expect(MAX_CREW).toBe(3);
    expect([0, 1, 2, 3].map(crewSize)).toEqual([0, 1, 2, 3]);
    expect(crewSize(9)).toBe(3);
  });
  it('treats nonsense as none', () => {
    expect(crewSize(-2)).toBe(0);
    expect(crewSize(Number.NaN)).toBe(0);
    expect(crewSize(1.9)).toBe(1);
  });
});

describe('crewMoods: what each helper on screen is doing', () => {
  it('every helper for a running agent digs', () => {
    expect(crewMoods(2, 2)).toEqual(['dig', 'dig']);
    expect(crewMoods(5, 3)).toEqual(['dig', 'dig', 'dig']);
    expect(crewMoods(0, 0)).toEqual([]);
  });
  it('a helper whose agent just finished cheers for a moment before it goes', () => {
    expect(crewMoods(1, 3)).toEqual(['dig', 'cheer', 'cheer']);
    expect(crewMoods(0, 2)).toEqual(['cheer', 'cheer']);
  });
});
