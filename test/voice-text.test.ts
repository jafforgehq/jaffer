import { describe, expect, it } from 'vitest';
import { chunkForSpeech, speakable } from '../src/shared/voice-text';

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

describe('chunkForSpeech', () => {
  const join = (a: string[]) => a.join(' ');
  it('empty -> none; short text -> one chunk', () => {
    expect(chunkForSpeech('')).toEqual([]);
    expect(chunkForSpeech('  ')).toEqual([]);
    expect(chunkForSpeech('Done.')).toEqual(['Done.']);
  });
  it('the first chunk is the first sentence when it is short', () => {
    const t = 'I fixed the build. Then I ran the tests and they all passed, which is good news for everyone.';
    expect(chunkForSpeech(t)[0]).toBe('I fixed the build.');
    expect(join(chunkForSpeech(t))).toBe(t);
  });
  it('a long first sentence is cut at a clause boundary within ~80 chars, never mid-word', () => {
    const t = 'First we read the configuration file, then we parse every single entry in it with great care and attention to detail, and finally we write it back.';
    const c = chunkForSpeech(t);
    expect(c[0]!.length).toBeLessThanOrEqual(80);
    expect(c[0]).toBe('First we read the configuration file,');
    expect(join(c)).toBe(t);
  });
  it('no clause boundary: cut at the last space before 80', () => {
    const t = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const c = chunkForSpeech(t);
    expect(c[0]!.length).toBeLessThanOrEqual(80);
    expect(t.startsWith(c[0]!)).toBe(true);
    expect(t[c[0]!.length]).toBe(' ');
    expect(join(c)).toBe(t);
  });
  it('the rest is chunked at sentence ends into <= ~300 chars', () => {
    const t = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the reply.`).join(' ');
    const c = chunkForSpeech(t);
    expect(c.length).toBeGreaterThan(3);
    for (const x of c.slice(1)) expect(x.length).toBeLessThanOrEqual(300);
    expect(join(c)).toBe(t);
  });
  it('a sentence longer than 300 with no end is split at spaces', () => {
    const t = 'x'.repeat(10) + ' ' + Array.from({ length: 200 }, () => 'abc').join(' ');
    const c = chunkForSpeech(t);
    for (const x of c) expect(x.length).toBeLessThanOrEqual(300);
    expect(join(c)).toBe(t);
  });
  it('a single unbroken run longer than the limit is hard-cut (progress guaranteed)', () => {
    const c = chunkForSpeech('y'.repeat(1000));
    expect(c.join('')).toBe('y'.repeat(1000));
    for (const x of c) expect(x.length).toBeLessThanOrEqual(300);
  });
});
