import { describe, expect, it } from 'vitest';
import { FailTracker } from '../src/renderer/fail-tracker';

describe('FailTracker: "Fixed it!" after three failures of one command and then a success', () => {
  it('is true when the same command exits 0 right after three failures', () => {
    const t = new FailTracker();
    expect(t.record('npm test', 1)).toBe(false);
    expect(t.record('npm test', 1)).toBe(false);
    expect(t.record('npm test', 2)).toBe(false);
    expect(t.record('npm test', 0)).toBe(true);
  });

  it('is not true after two failures, and counts start again after the win', () => {
    const t = new FailTracker();
    t.record('make', 1);
    t.record('make', 1);
    expect(t.record('make', 0)).toBe(false);
    for (let i = 0; i < 3; i++) t.record('make', 1);
    expect(t.record('make', 0)).toBe(true);
    expect(t.record('make', 0)).toBe(false); // the run ended with that success
    t.record('make', 1);
    expect(t.record('make', 0)).toBe(false);
  });

  it('counts per command text: another command in between changes nothing, and a success of one does not end the other', () => {
    const t = new FailTracker();
    t.record('a', 1);
    t.record('b', 0);
    t.record('a', 1);
    t.record('ls', 0);
    t.record('a', 127);
    expect(t.record('a', 0)).toBe(true);
    expect(t.record('b', 0)).toBe(false);
  });

  it('a failure after a success starts a new run (success of the same text resets)', () => {
    const t = new FailTracker();
    t.record('x', 1);
    t.record('x', 1);
    t.record('x', 0);
    t.record('x', 1);
    expect(t.record('x', 0)).toBe(false);
  });

  it('ignores an unknown exit, an empty command, a sensitive one and an overlong one', () => {
    const t = new FailTracker();
    for (let i = 0; i < 3; i++) t.record('npm test', 1);
    t.record('npm test', null);
    expect(t.record('npm test', 0)).toBe(true);
    for (const c of ['', '   ']) {
      for (let i = 0; i < 3; i++) t.record(c, 1);
      expect(t.record(c, 0)).toBe(false);
    }
    const secret = 'cat .env';
    for (let i = 0; i < 3; i++) t.record(secret, 1);
    expect(t.record(secret, 0)).toBe(false);
    const long = 'x'.repeat(20_000);
    for (let i = 0; i < 3; i++) t.record(long, 1);
    expect(t.record(long, 0)).toBe(false);
  });

  it('keeps at most 50 commands: the oldest is forgotten', () => {
    const t = new FailTracker();
    for (let i = 0; i < 3; i++) t.record('first', 1);
    for (let n = 0; n < 50; n++) t.record(`cmd-${n}`, 1);
    expect(t.size).toBeLessThanOrEqual(50);
    expect(t.record('first', 0)).toBe(false);
    for (let i = 0; i < 3; i++) t.record('cmd-49', 1);
    expect(t.record('cmd-49', 0)).toBe(true);
  });
});
