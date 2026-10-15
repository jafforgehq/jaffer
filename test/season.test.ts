import { describe, expect, it } from 'vitest';
import { seasonOf } from '../src/shared/season';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0); // local time, as the person's clock

describe('seasonOf: the date picks a small seasonal touch for the companion (local date, none most of the year)', () => {
  it('halloween: Oct 24 to Nov 1, both ends in, the days around out', () => {
    expect(seasonOf(at(2026, 10, 23, 23))).toBeNull();
    expect(seasonOf(at(2026, 10, 24, 0))).toBe('halloween');
    expect(seasonOf(at(2026, 10, 31))).toBe('halloween');
    expect(seasonOf(at(2026, 11, 1, 23))).toBe('halloween');
    expect(seasonOf(at(2026, 11, 2, 0))).toBeNull();
  });

  it('winter: Dec 15 to Jan 3 across the year end', () => {
    expect(seasonOf(at(2026, 12, 14, 23))).toBeNull();
    expect(seasonOf(at(2026, 12, 15, 0))).toBe('winter');
    expect(seasonOf(at(2026, 12, 31))).toBe('winter');
    expect(seasonOf(at(2027, 1, 1))).toBe('winter');
    expect(seasonOf(at(2027, 1, 3, 23))).toBe('winter');
    expect(seasonOf(at(2027, 1, 4, 0))).toBeNull();
  });

  it('valentine: Feb 12 to Feb 15', () => {
    expect(seasonOf(at(2027, 2, 11, 23))).toBeNull();
    expect(seasonOf(at(2027, 2, 12, 0))).toBe('valentine');
    expect(seasonOf(at(2027, 2, 14))).toBe('valentine');
    expect(seasonOf(at(2027, 2, 15, 23))).toBe('valentine');
    expect(seasonOf(at(2027, 2, 16, 0))).toBeNull();
  });

  it('none for an ordinary day, and for a date that is not one', () => {
    expect(seasonOf(at(2026, 7, 4))).toBeNull();
    expect(seasonOf(at(2026, 10, 15))).toBeNull();
    expect(seasonOf(new Date(Number.NaN))).toBeNull();
  });
});
