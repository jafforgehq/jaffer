import { describe, expect, it } from 'vitest';
import { parseMd } from '../src/shared/mini-md';

describe('mini-md: the release notes as data (never HTML)', () => {
  it('headings, bullets, paragraphs, **bold** and `code`', () => {
    const md = ['## Titles', '', 'Plain **bold** and `code` here.', 'Second line.', '', '- one', '- **two** `x`', '', '### Limits', '- last'].join('\n');
    expect(parseMd(md)).toEqual([
      { kind: 'h', level: 2, inline: [{ text: 'Titles' }] },
      { kind: 'p', inline: [{ text: 'Plain ' }, { text: 'bold', style: 'b' }, { text: ' and ' }, { text: 'code', style: 'code' }, { text: ' here. Second line.' }] },
      { kind: 'ul', items: [[{ text: 'one' }], [{ text: 'two', style: 'b' }, { text: ' ' }, { text: 'x', style: 'code' }]] },
      { kind: 'h', level: 3, inline: [{ text: 'Limits' }] },
      { kind: 'ul', items: [[{ text: 'last' }]] },
    ]);
  });

  it('*italic* too (the notes use it), but not a lone star or a star before a space', () => {
    expect(parseMd('see *Settings* and 2 * 3 and a* b')).toEqual([{ kind: 'p', inline: [{ text: 'see ' }, { text: 'Settings', style: 'i' }, { text: ' and 2 * 3 and a* b' }] }]);
  });

  it('code inside bold or italic stays code, and the rest keeps the style', () => {
    expect(parseMd('**copies `a/b` now** and *runs `x` fine*')).toEqual([
      { kind: 'p', inline: [{ text: 'copies ', style: 'b' }, { text: 'a/b', style: 'code' }, { text: ' now', style: 'b' }, { text: ' and ' }, { text: 'runs ', style: 'i' }, { text: 'x', style: 'code' }, { text: ' fine', style: 'i' }] },
    ]);
  });

  it('a single # is a heading too (level 2), CRLF is fine, and a lone marker with no closer is just text', () => {
    expect(parseMd('# Big\r\n\r\ntext **open and `tick')).toEqual([
      { kind: 'h', level: 2, inline: [{ text: 'Big' }] },
      { kind: 'p', inline: [{ text: 'text **open and `tick' }] },
    ]);
  });

  it('HTML stays text: nothing is ever turned into an element', () => {
    const [b] = parseMd('<img src=x onerror=alert(1)> and <b>no</b> `<script>`');
    expect(b).toEqual({ kind: 'p', inline: [{ text: '<img src=x onerror=alert(1)> and <b>no</b> ' }, { text: '<script>', style: 'code' }] });
  });

  it('is bounded: a 1 MB and an 8 MB line, of the shapes that make a naive parser slow, finish fast', () => {
    for (const size of [1024 * 1024, 8 * 1024 * 1024]) {
      for (const unit of ['**a', '`', '- ', '*', '#', 'x ']) {
        const t0 = performance.now();
        const blocks = parseMd(unit.repeat(Math.ceil(size / unit.length)));
        expect(performance.now() - t0, `${unit} x ${size}`).toBeLessThan(250);
        expect(JSON.stringify(blocks).length).toBeLessThan(1_000_000);
      }
      const t0 = performance.now();
      parseMd('- item\n'.repeat(size / 7));
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
