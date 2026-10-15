import { describe, expect, it } from 'vitest';
import { IMAGE_COLS, IMAGE_LINES, layoutBlockImage } from '../src/renderer/block-image';

describe('layoutBlockImage: what "Copy as image" draws', () => {
  it('the command as `$ <cmd>` on the first line, then the output; no command, no command line', () => {
    expect(layoutBlockImage({ command: 'echo hi', output: 'hi\nthere' })).toEqual({ lines: ['$ echo hi', 'hi', 'there'], truncated: false });
    expect(layoutBlockImage({ output: 'hi' })).toEqual({ lines: ['hi'], truncated: false });
    expect(layoutBlockImage({ command: 'a\n  b', output: '' }).lines).toEqual(['$ a b']); // a command of several lines is one line
    expect(layoutBlockImage({ output: 'a\r\nb\rc' }).lines).toEqual(['a', 'b', 'c']);
  });

  it(`at most ${IMAGE_LINES} lines of output and ${IMAGE_COLS} columns: the rest is cut with "…"`, () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const r = layoutBlockImage({ command: 'seq', output: many });
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(1 + IMAGE_LINES + 1);
    expect(r.lines[IMAGE_LINES]).toBe(`line ${IMAGE_LINES - 1}`);
    expect(r.lines.at(-1)).toBe('…');
    const wide = layoutBlockImage({ output: 'x'.repeat(500) });
    expect(wide.lines[0]).toHaveLength(IMAGE_COLS);
    expect(wide.lines[0]!.endsWith('…')).toBe(true);
    expect(wide.truncated).toBe(false); // (a long line is cut where it is; nothing was left out below)
    expect(layoutBlockImage({ output: 'y'.repeat(IMAGE_COLS) }).lines[0]).toBe('y'.repeat(IMAGE_COLS));
    expect(layoutBlockImage({ output: 'z'.repeat(50), cols: 20 }).lines[0]).toBe(`${'z'.repeat(19)}…`);
  });

  it('expands tabs to the next stop of 8 and removes control and escape characters', () => {
    expect(layoutBlockImage({ output: 'a\tb\t\tc' }).lines[0]).toBe('a       b               c');
    expect(layoutBlockImage({ output: '\x1b[31mred\x1b[0m \x07bell\x00\x7f\x9b' }).lines[0]).toBe('red bell');
    expect(layoutBlockImage({ command: 'echo \x1b]0;title\x07x', output: '' }).lines[0]).toBe('$ echo ]0;titlex');
    expect(layoutBlockImage({ output: '\t'.repeat(100) }).lines[0]!.length).toBeLessThanOrEqual(IMAGE_COLS);
  });

  it('is quick on hostile input: 1 MB and 8 MB lines, 8 MB of newlines, tabs or escapes', () => {
    for (const n of [1 << 20, 8 << 20]) {
      for (const s of ['a'.repeat(n), '\n'.repeat(n), '\t'.repeat(n), '\x1b['.repeat(n / 2), `\x1b[${'1;'.repeat(n / 2)}`]) {
        const t = performance.now();
        const r = layoutBlockImage({ command: s, output: s });
        expect(performance.now() - t).toBeLessThan(250);
        expect(r.lines.length).toBeLessThanOrEqual(IMAGE_LINES + 2);
        for (const l of r.lines) expect(l.length).toBeLessThanOrEqual(IMAGE_COLS);
      }
    }
  });
});
