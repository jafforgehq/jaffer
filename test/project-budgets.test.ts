import { describe, expect, it } from 'vitest';
import { budgetLevels, parseProjectBudgets } from '../src/shared/project-budgets';

const HOME = '/Users/maya';
const NOW = new Date(2026, 9, 16, 15, 0).getTime();
const DAY = 86_400_000;

describe('parseProjectBudgets: "<folder>=<usd per week>", one per line, tolerant', () => {
  it('reads absolute and ~ folders (no trailing slash), skips bad lines, at most 20', () => {
    expect(parseProjectBudgets(['/work/api=20', ' ~/code/web/ = 7.5 ', '~=3', 'nonsense', '=5', '/x=', '/y=-2', '/z=abc', 'rel/path=4', 5 as never, `/${'a'.repeat(5000)}=1`], HOME)).toEqual([
      { cwd: '/work/api', usd: 20 },
      { cwd: '/Users/maya/code/web', usd: 7.5 },
      { cwd: '/Users/maya', usd: 3 },
    ]);
    expect(parseProjectBudgets(Array.from({ length: 30 }, (_, i) => `/p${i}=1`), HOME)).toHaveLength(20);
    expect(parseProjectBudgets('x' as never, HOME)).toEqual([]);
    expect(parseProjectBudgets(['/a/b=5', '/a/b/=9'], HOME)).toEqual([{ cwd: '/a/b', usd: 5 }]); // the first one for a folder wins
    expect(parseProjectBudgets(['/=5', '/a=b=5'], HOME)).toEqual([{ cwd: '/', usd: 5 }, { cwd: '/a=b', usd: 5 }]); // (the last = splits: a folder may hold one)
  });
});

describe('budgetLevels: the last 7 days of each budget folder against its budget, from the costed conversations', () => {
  it('ok, warn from 80 %, danger from 100 %; only the folder itself, only the last 7 days, only rows with a cost', () => {
    const rows = [
      { cwd: '/work/api', endedAt: NOW - 1 * DAY, usd: 10 },
      { cwd: '/work/api', endedAt: NOW - 2 * DAY, usd: 7 },
      { cwd: '/work/api', endedAt: NOW - 8 * DAY, usd: 100 }, // older than a week
      { cwd: '/work/api/sub', endedAt: NOW - DAY, usd: 100 }, // another folder
      { cwd: '/Users/maya/code/web', endedAt: NOW - DAY, usd: 7.5 },
      { cwd: '/Users/maya/code/web', endedAt: NOW - DAY },
      { cwd: '/quiet', endedAt: NOW - DAY, usd: 0.5 },
      { cwd: '/quiet', endedAt: NOW + DAY, usd: 50 }, // (a clock that went back)
    ];
    const budgets = [
      { cwd: '/work/api', usd: 20 },
      { cwd: '/Users/maya/code/web', usd: 7.5 },
      { cwd: '/quiet', usd: 10 },
      { cwd: '/never', usd: 10 },
    ];
    expect(budgetLevels(rows, budgets, NOW)).toEqual([
      { cwd: '/work/api', usd: 17, budget: 20, level: 'warn' },
      { cwd: '/Users/maya/code/web', usd: 7.5, budget: 7.5, level: 'danger' },
      { cwd: '/quiet', usd: 0.5, budget: 10, level: 'ok' },
      { cwd: '/never', usd: 0, budget: 10, level: 'ok' },
    ]);
    expect(budgetLevels(null as never, budgets, NOW).map((b) => b.level)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(budgetLevels(rows, [], NOW)).toEqual([]);
  });

  it('a line of slashes that does not end in one is quick (no backtracking run before the end)', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `/${'/'.repeat(4000)}x${i}=5`);
    const t = Date.now();
    const b = parseProjectBudgets(lines, '/Users/maya');
    expect(Date.now() - t).toBeLessThan(100);
    expect(b).toHaveLength(20);
    expect(parseProjectBudgets(['/a///=1', '///=2', '~/=3'], '/Users/maya')).toEqual([{ cwd: '/a', usd: 1 }, { cwd: '/', usd: 2 }, { cwd: '/Users/maya', usd: 3 }]);
  });
});
