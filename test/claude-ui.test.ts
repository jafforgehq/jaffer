import { describe, expect, it } from 'vitest';
import { baseName, budgetLevel, gitText, hookHealthWarning, ordinal, progressFraction, sessionClockText, sparkPath, turnBars, turnCounts, turnSummaryText } from '../src/renderer/claude-ui';

describe('the title bar’s Claude helpers (pure)', () => {
  it('progressFraction: elapsed against the typical turn, 0 without one, never past 1, nothing odd from odd input', () => {
    expect(progressFraction(30_000, 60_000)).toBe(0.5);
    expect(progressFraction(90_000, 60_000)).toBe(1);
    expect(progressFraction(10_000, 0)).toBe(0);
    expect(progressFraction(10_000, -5)).toBe(0);
    expect(progressFraction(-1_000, 60_000)).toBe(0);
    expect(progressFraction(Number.NaN, 60_000)).toBe(0);
    expect(progressFraction(1_000, Number.NaN)).toBe(0);
  });

  it('budgetLevel: off without a budget, warn from 80 %, danger from 100 %', () => {
    expect(budgetLevel(5, 0)).toBe('off');
    expect(budgetLevel(5, -1)).toBe('off');
    expect(budgetLevel(0, 10)).toBe('ok');
    expect(budgetLevel(7.99, 10)).toBe('ok');
    expect(budgetLevel(8, 10)).toBe('warn');
    expect(budgetLevel(9.99, 10)).toBe('warn');
    expect(budgetLevel(10, 10)).toBe('danger');
    expect(budgetLevel(25, 10)).toBe('danger');
    expect(budgetLevel(Number.NaN, 10)).toBe('ok');
  });

  it('turnSummaryText: the length, the calls in words (singular and plural, zeros left out), the cost only when given', () => {
    expect(turnSummaryText({ durMs: 72_000, counts: { read: 3, write: 2, shell: 1 }, usd: 0.04 })).toBe('Claude finished in 1m 12s · 3 reads, 2 edits, 1 shell · ≈ $0.04');
    expect(turnSummaryText({ durMs: 12_000, counts: { read: 1, write: 1, shell: 2, web: 1, agent: 2, other: 0 } })).toBe('Claude finished in 12s · 1 read, 1 edit, 2 shells, 1 web, 2 agents');
    expect(turnSummaryText({ durMs: 15_000, counts: {} })).toBe('Claude finished in 15s');
    expect(turnSummaryText({ durMs: 15_000, counts: { other: 2 }, usd: 1.2 })).toBe('Claude finished in 15s · 2 other · ≈ $1.20');
  });

  it('turnCounts: only the calls of this turn (a background-agent turn without a prompt keeps the last prompt’s calls)', () => {
    const calls = [
      { name: 'Read', category: 'read' as const, startedAt: 100 },
      { name: 'Bash', category: 'shell' as const, startedAt: 200 },
      { name: 'Edit', category: 'write' as const, startedAt: 300 },
      { name: 'Read', category: 'read' as const, startedAt: 400 },
    ];
    expect(turnCounts(calls, 250)).toEqual({ write: 1, read: 1 });
    expect(turnCounts(calls, undefined)).toEqual({ read: 2, shell: 1, write: 1 });
    expect(turnCounts(undefined, 0)).toEqual({});
    expect(turnCounts([null, 7, 'x', { name: 'Read' }, { name: 'Bash', category: 'shell', startedAt: 'soon' }, { name: 'Bash', category: 'shell', startedAt: 300 }] as never, 0)).toEqual({ shell: 1 }); // odd entries are skipped
  });

  it('sessionClockText: how long, how many turns, the cost only when given', () => {
    const now = 1_000_000_000;
    expect(sessionClockText({ startedAt: now - 42 * 60_000, now, turns: 9, usd: 1.2 })).toBe('Claude · 42 min · 9 turns · ≈ $1.20');
    expect(sessionClockText({ startedAt: now - 20_000, now, turns: 1 })).toBe('Claude · < 1 min · 1 turn');
    expect(sessionClockText({ startedAt: now - 125 * 60_000, now, turns: 0 })).toBe('Claude · 2 h 5 min · 0 turns');
    expect(sessionClockText({ now })).toBe('Claude');
  });

  it('gitText: staged, changed, untracked, ahead, behind; zeros left out; nothing when there is no repository', () => {
    expect(gitText({ staged: 2, changed: 3, untracked: 1, ahead: 1, behind: 0 })).toBe('+2 ~3 ?1 ↑1');
    expect(gitText({ staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 4 })).toBe('↓4');
    expect(gitText({ staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 })).toBe('');
    expect(gitText(undefined)).toBe('');
    expect(gitText({ staged: 'x', changed: null } as never)).toBe('');
  });

  it('baseName and ordinal', () => {
    expect(baseName('/Users/maya/code/api/src/app.ts')).toBe('app.ts');
    expect(baseName('/Users/maya/code/')).toBe('code');
    expect(baseName('app.ts')).toBe('app.ts');
    expect(baseName('')).toBe('');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
  });

  it('sparkPath: a line through the values scaled into the box; nothing for fewer than two', () => {
    expect(sparkPath([1, 3, 2], 40, 10)).toBe('M0 10 L20 0 L40 5');
    expect(sparkPath([2, 2], 40, 10)).toBe('M0 5 L40 5'); // flat: in the middle
    expect(sparkPath([5], 40, 10)).toBe('');
    expect(sparkPath([], 40, 10)).toBe('');
  });
});

describe('hookHealthWarning (pure)', () => {
  const H = 3_600_000;
  const now = 100 * H;
  const ev = (o: Record<string, number | null>) => ({ SessionStart: null, Stop: null, ...o });

  it('warns when SessionStart was seen over an hour ago and Stop never came, or came before it, while nothing works', () => {
    const text = 'Stop has not arrived for over an hour: the hooks may be broken. Try Reinstall.';
    expect(hookHealthWarning(ev({ SessionStart: now - 2 * H }), now, false)).toBe(text);
    expect(hookHealthWarning(ev({ SessionStart: now - 2 * H, Stop: now - 3 * H }), now, false)).toBe(text);
  });

  it('says nothing for a healthy or an unknown state', () => {
    expect(hookHealthWarning(ev({}), now, false)).toBeNull(); // no SessionStart seen: nothing to judge
    expect(hookHealthWarning(ev({ SessionStart: now - 2 * H, Stop: now - H }), now, false)).toBeNull(); // Stop after SessionStart
    expect(hookHealthWarning(ev({ SessionStart: now - H }), now, false)).toBeNull(); // exactly an hour: not over
    expect(hookHealthWarning(ev({ SessionStart: now - 10 * 60_000 }), now, false)).toBeNull();
    expect(hookHealthWarning(ev({ SessionStart: now - 2 * H }), now, true)).toBeNull(); // a session is working: Stop is not due
    expect(hookHealthWarning({}, now, false)).toBeNull();
    expect(hookHealthWarning(ev({ SessionStart: Number.NaN }), now, false)).toBeNull();
  });
});

describe('turnBars: the Now card’s bars for the last turns (pure geometry)', () => {
  it('a bar a turn: height by length against the longest, a cost level against the costliest, a title of time and cost', () => {
    const r = turnBars([{ durMs: 60_000, usd: 0.04 }, { durMs: 30_000, usd: 0.01 }, { durMs: 72_000, usd: 0.02 }], true)!;
    expect([r.w, r.h]).toEqual([22, 28]);
    expect(r.bars).toEqual([
      { x: 0, y: 5, w: 6, h: 23, level: 'high', title: '1m 0s · ≈ $0.04' },
      { x: 8, y: 16, w: 6, h: 12, level: 'low', title: '30s · ≈ $0.01' },
      { x: 16, y: 0, w: 6, h: 28, level: 'mid', title: '1m 12s · ≈ $0.02' },
    ]);
    expect(r.label).toBe('Last 3 turns: the latest took 1m 12s, the longest 1m 12s');
  });

  it('without showCost no cost anywhere; a turn whose cost is not known has none either; equal costs are all low', () => {
    const r = turnBars([{ durMs: 60_000, usd: 0.04 }, { durMs: 30_000, usd: 0.01 }], false)!;
    expect(r.bars.map((b) => [b.level, b.title])).toEqual([['none', '1m 0s'], ['none', '30s']]);
    expect(JSON.stringify(r)).not.toContain('$');
    expect(turnBars([{ durMs: 5000 }, { durMs: 5000, usd: 0.5 }], true)!.bars.map((b) => [b.level, b.title])).toEqual([['none', '5s'], ['low', '5s · ≈ $0.50']]);
    expect(turnBars([{ durMs: 5000, usd: 0.1 }, { durMs: 5000, usd: 0.1 }], true)!.bars.map((b) => b.level)).toEqual(['low', 'low']);
  });

  it('nothing for fewer than two turns; at most the last 20; odd lengths are small bars, never NaN', () => {
    expect(turnBars([], true)).toBeNull();
    expect(turnBars([{ durMs: 1000 }], true)).toBeNull();
    const many = Array.from({ length: 25 }, (_, i) => ({ durMs: (i + 1) * 1000 }));
    const r = turnBars(many, true)!;
    expect(r.bars.length).toBe(20);
    expect(r.bars[0]!.title).toBe('6s'); // the 6th of 25 is the first of the last 20
    expect(r.w).toBe(20 * 8 - 2);
    const odd = turnBars([{ durMs: Number.NaN }, { durMs: -4 }, { durMs: 0 }], true)!;
    expect(odd.bars.map((b) => b.h)).toEqual([2, 2, 2]);
    expect(JSON.stringify(odd)).not.toContain('null');
  });
});
