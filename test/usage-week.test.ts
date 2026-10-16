import { describe, expect, it } from 'vitest';
import { digestDue, digestLine, digestText, rollWeek, weekId, type UsageWeeks } from '../src/shared/usage-week';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime(); // local time, as the person's clock
const empty = (): UsageWeeks => ({ week: { id: '', usd: 0, workMs: 0 }, lastWeek: { id: '', usd: 0, workMs: 0 }, digestWeek: '' });

describe('weekId: the ISO week of a local date (Monday to Sunday)', () => {
  it('Monday 00:00 starts a week, Sunday 23:59 ends it', () => {
    expect(weekId(at(2026, 10, 12, 0, 0))).toBe('2026-W42'); // a Monday
    expect(weekId(at(2026, 10, 18, 23, 59))).toBe('2026-W42'); // its Sunday
    expect(weekId(at(2026, 10, 19, 0, 0))).toBe('2026-W43');
    expect(weekId(at(2026, 10, 11, 23, 59))).toBe('2026-W41');
  });

  it('at the edges of a year the week belongs to the year of its Thursday', () => {
    expect(weekId(at(2021, 1, 3))).toBe('2020-W53'); // a Sunday: 2020 had 53 weeks
    expect(weekId(at(2021, 1, 4))).toBe('2021-W01');
    expect(weekId(at(2024, 12, 30))).toBe('2025-W01'); // a Monday in December
    expect(weekId(at(2026, 12, 31))).toBe('2026-W53');
    expect(weekId(at(2027, 1, 1))).toBe('2026-W53');
    expect(weekId(at(2027, 1, 4))).toBe('2027-W01');
  });

  it('pads the week; nothing odd from an odd time', () => {
    expect(weekId(at(2026, 1, 7))).toBe('2026-W02');
    expect(weekId(Number.NaN)).toBe('');
  });
});

describe('rollWeek: a counted turn adds to this week; a new week moves this one to last week', () => {
  it('adds the cost and the time of a turn (one under a second is no time)', () => {
    let u = rollWeek(empty(), at(2026, 10, 13), 0.5, 60_000);
    u = rollWeek(u, at(2026, 10, 14), 0.25, 999);
    u = rollWeek(u, at(2026, 10, 18, 23, 0), 0, 1000);
    expect(u).toEqual({ week: { id: '2026-W42', usd: 0.75, workMs: 61_000 }, lastWeek: { id: '', usd: 0, workMs: 0 }, digestWeek: '' });
  });

  it('a new week: this week becomes last week, the new one starts from this turn; the digest mark stays', () => {
    const u = rollWeek({ ...rollWeek(empty(), at(2026, 10, 13), 1, 5000), digestWeek: '2026-W41' }, at(2026, 10, 20), 0.1, 2000);
    expect(u).toEqual({ week: { id: '2026-W43', usd: 0.1, workMs: 2000 }, lastWeek: { id: '2026-W42', usd: 1, workMs: 5000 }, digestWeek: '2026-W41' });
    // weeks with nothing in between: the older week is kept as it was (the digest only speaks of the week just past)
    expect(rollWeek(u, at(2026, 11, 16), 0, 0)).toEqual({ week: { id: '2026-W47', usd: 0, workMs: 0 }, lastWeek: { id: '2026-W43', usd: 0.1, workMs: 2000 }, digestWeek: '2026-W41' });
  });

  it('takes nothing odd: no NaN, no negative, no odd shape', () => {
    const u = rollWeek(empty(), at(2026, 10, 13), 1, 2000);
    expect(rollWeek(u, at(2026, 10, 13), Number.NaN, -5)).toEqual(u);
    expect(rollWeek(u, at(2026, 10, 13), -1, Infinity)).toEqual(u);
    expect(rollWeek({ week: null, lastWeek: 'x', digestWeek: 5 } as never, at(2026, 10, 13), 1, 0)).toEqual({ week: { id: '2026-W42', usd: 1, workMs: 0 }, lastWeek: { id: '', usd: 0, workMs: 0 }, digestWeek: '' });
  });
});

describe('digestDue: once per finished week, at the app\'s start', () => {
  const used = (id: string, usd: number, workMs: number) => ({ id, usd, workMs });

  it('the week just past, when it had any cost or time and was not told yet', () => {
    const now = at(2026, 10, 19, 9); // Monday of W43
    expect(digestDue({ ...empty(), week: used('2026-W43', 1, 1000), lastWeek: used('2026-W42', 3, 45_000_000) }, now)).toEqual(used('2026-W42', 3, 45_000_000));
    expect(digestDue({ ...empty(), week: used('2026-W43', 1, 1000), lastWeek: used('2026-W42', 3, 45_000_000), digestWeek: '2026-W42' }, now)).toBeNull(); // told already
    expect(digestDue({ ...empty(), lastWeek: used('2026-W42', 0, 0) }, now)).toBeNull(); // nothing in it
    expect(digestDue({ ...empty(), lastWeek: used('2026-W40', 3, 1000) }, now)).toBeNull(); // not the week just past
    expect(digestDue(empty(), now)).toBeNull();
  });

  it('this week\'s numbers are the week just past when no turn was counted since the week changed', () => {
    const now = at(2026, 10, 20, 9);
    expect(digestDue({ ...empty(), week: used('2026-W42', 2, 60_000), lastWeek: used('2026-W41', 9, 1000), digestWeek: '2026-W41' }, now)).toEqual(used('2026-W42', 2, 60_000));
    expect(digestDue({ ...empty(), week: used('2026-W43', 2, 60_000) }, now)).toBeNull(); // the week goes on
  });

  it('odd values are no digest', () => {
    expect(digestDue(null as never, at(2026, 10, 19))).toBeNull();
    expect(digestDue({ week: 'x', lastWeek: { id: '2026-W42', usd: 'a', workMs: null }, digestWeek: '' } as never, at(2026, 10, 19))).toBeNull();
  });
});

describe('digestText', () => {
  it('the cost (only with showCost) and the time', () => {
    expect(digestText({ id: '2026-W42', usd: 12.4, workMs: 45_000_000 }, true)).toEqual({ title: 'Last week with Claude', body: '≈ $12.40, 12h 30m' });
    expect(digestText({ id: '2026-W42', usd: 12.4, workMs: 45_000_000 }, false)).toEqual({ title: 'Last week with Claude', body: '12h 30m' });
    expect(digestText({ id: '2026-W42', usd: 2, workMs: 0 }, true).body).toBe('≈ $2.00');
    expect(digestText({ id: '2026-W42', usd: 2, workMs: 0 }, false).body).toBe('Claude Code worked with you last week.');
  });

  it('digestLine: the one line of the window\'s toast, from the same words', () => {
    expect(digestLine({ id: '2026-W42', usd: 12.4, workMs: 45_000_000 }, true)).toBe('Last week with Claude: ≈ $12.40, 12h 30m');
    expect(digestLine({ id: '2026-W42', usd: 12.4, workMs: 45_000_000 }, false)).toBe('Last week with Claude: 12h 30m');
  });
});
