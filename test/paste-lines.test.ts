import { describe, expect, it } from 'vitest';
import { firstLine, lineCount } from '../src/renderer/state';

describe('lineCount and firstLine: what the paste guard counts', () => {
  it('counts \\r\\n, \\n and a lone \\r as line breaks; a trailing break does not start a line', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('ls')).toBe(1);
    expect(lineCount('ls\n')).toBe(1);
    expect(lineCount('ls\r\n')).toBe(1);
    expect(lineCount('ls\r')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\r\nb\r\n')).toBe(2);
    expect(lineCount('a\rb\rc')).toBe(3);
    expect(lineCount('a\n\nb')).toBe(3);
  });

  it('the first line ends at any of them', () => {
    expect(firstLine('echo a\rrm -rf x')).toBe('echo a');
    expect(firstLine('echo a\r\nb')).toBe('echo a');
    expect(firstLine('one')).toBe('one');
  });

  it('is quick on 8 MB', () => {
    const big = 'x\r'.repeat(4 << 20);
    const t0 = performance.now();
    expect(lineCount(big)).toBe(4 << 20);
    expect(firstLine(big)).toBe('x');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
