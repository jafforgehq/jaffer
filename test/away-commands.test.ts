import { describe, expect, it } from 'vitest';
import { awayText, fmtDuration } from '../src/renderer/state';

describe('fmtDuration', () => {
  it('seconds, minutes and seconds, hours and minutes', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(45_400)).toBe('45s');
    expect(fmtDuration(252_000)).toBe('4m 12s');
    expect(fmtDuration(60_000)).toBe('1m 0s');
    expect(fmtDuration(3_780_000)).toBe('1h 3m');
    expect(fmtDuration(-5)).toBe('0s');
    expect(fmtDuration(Number.NaN)).toBe('0s');
  });
});

describe('awayText: the toast for long commands that finished while the window was away', () => {
  it('names the most recent through safeCommand, clipped to 40, with its time and exit, and how many more', () => {
    expect(awayText([{ cmd: 'make', exit: 0, durMs: 252_000 }])).toBe('make finished in 4m 12s (exit 0)');
    expect(awayText([{ cmd: 'npm test', exit: 1, durMs: 31_000 }, { cmd: 'make', exit: 0, durMs: 40_000 }, { cmd: 'x', exit: 0, durMs: 40_000 }])).toBe('npm test finished in 31s (exit 1) and 2 more');
    expect(awayText([{ cmd: `echo ${'a'.repeat(80)}`, exit: null, durMs: 30_000 }])).toBe(`echo ${'a'.repeat(35)} finished in 30s`);
  });

  it('never names a sensitive command, and redacts secrets', () => {
    expect(awayText([{ cmd: 'cat ~/.ssh/id_rsa', exit: 0, durMs: 30_000 }])).toBe('A command finished in 30s (exit 0)');
    expect(awayText([{ cmd: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', exit: 0, durMs: 30_000 }])).not.toMatch(/ghp_/);
    expect(awayText([{ cmd: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnop" x', exit: 0, durMs: 30_000 }])).not.toMatch(/sk-ant-api03/);
  });
});
