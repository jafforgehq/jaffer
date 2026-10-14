import { describe, expect, it } from 'vitest';
import { baseName, budgetLevel, gitText, hookHealthWarning, ordinal, progressFraction, sessionClockText, sparkPath, turnCounts, turnSummaryText } from '../src/renderer/claude-ui';

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
