import { describe, expect, it } from 'vitest';
import { speakable } from '../src/shared/voice-text';

describe('speakable', () => {
  it('drops fenced code, also an unclosed fence, and indented code', () => {
    expect(speakable('Run this.\n```ts\nconst a = 1;\n```\nDone.')).toBe('Run this. Done.');
    expect(speakable('Before.\n~~~\nrm -rf x\n~~~\nAfter.')).toBe('Before. After.');
    expect(speakable('Before.\n```\nnever closed\nmore code')).toBe('Before.');
    expect(speakable('Look:\n\n    const x = 1;\n    y();\n\nThen done.')).toBe('Look: Then done.');
  });
  it('drops inline code, URLs, paths and tags', () => {
    const s = speakable('Edit `foo()` in /a/b.ts and ~/x and ./y/z and src/a.ts:12, see https://example.com/q?a=1 now. <b>Bold</b> and/or more.');
    expect(s).not.toMatch(/foo|\/a\/b|~\/x|src\/a|https|<b>/);
    expect(s).toContain('and/or more');
  });
  it('drops diff and tool lines, keeps quotes and bullets', () => {
    const s = speakable('Changed:\n@@ -1 +1 @@\n+ added\n-removed\n$ npm test\n| a | b |\n> quoted prose\n- a bullet');
    expect(s).toBe('Changed: quoted prose a bullet');
  });
  it('strips markdown marks', () => {
    expect(speakable('# Title\n**bold** and _it_ and [a link](http://x.y/z) and __more__.')).toBe('Title bold and it and a link and more.');
  });
  it('returns empty for code-only replies', () => {
    expect(speakable('```js\nx()\n```')).toBe('');
    expect(speakable('`a` `b`')).toBe('');
    expect(speakable('')).toBe('');
  });
  it('cuts at a sentence end within 1500 characters, else at a word', () => {
    const sent = 'This is a sentence. '.repeat(200);
    const a = speakable(sent);
    expect(a.length).toBeLessThanOrEqual(1500);
    expect(a.endsWith('.')).toBe(true);
    const words = speakable('word '.repeat(1000));
    expect(words.length).toBeLessThanOrEqual(1500);
    expect(words.endsWith('word')).toBe(true);
  });
  it('redacts secrets', () => {
    const s = speakable('The key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ok.');
    expect(s).not.toContain('AbCdEfGhIjKlMnOp');
  });
  it('is linear on huge lines', () => {
    for (const unit of ['a', '`', '[', '/', '*', ' ']) {
      for (const n of [1 << 20, 8 << 20]) {
        const t = Date.now();
        speakable(unit.repeat(n));
        expect(Date.now() - t).toBeLessThan(1000);
      }
    }
  });
});
