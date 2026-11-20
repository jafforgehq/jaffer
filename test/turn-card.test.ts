import { describe, expect, it } from 'vitest';
import { turnCardLines } from '../src/renderer/turn-card';

describe('turnCardLines', () => {
  it('is empty without a summary', () => {
    expect(turnCardLines(undefined, [])).toEqual([]);
    expect(turnCardLines('  ', ['a.ts'])).toEqual([]);
  });
  it('splits the summary into lines, then the files and a footer', () => {
    expect(turnCardLines('Claude finished in 7s · 1 read, 1 edit · ≈ $0.13', ['session.ts', 'token.ts'])).toEqual(['Claude finished in 7s', '1 read, 1 edit', '≈ $0.13', '', 'edited session.ts, token.ts', '', '— Jaffer']);
  });
  it('lists at most five files and counts the rest', () => {
    const l = turnCardLines('Claude finished in 1m', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3);
    expect(l).toContain('edited a, b, c, d, e +5 more');
    expect(turnCardLines('x', ['a'], 2)).toContain('edited a +2 more');
  });
});
