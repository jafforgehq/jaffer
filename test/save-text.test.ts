import { describe, expect, it } from 'vitest';
import { SAVE_TEXT_MAX, safeFileName, utf8Bytes } from '../src/shared/save-text';

describe('safeFileName: the name the save dialog suggests', () => {
  it('keeps a plain name', () => {
    expect(safeFileName('make-output.txt')).toBe('make-output.txt');
  });

  it('only the last part of a path, only letters, digits, dot, dash and underscore, no leading dots', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\x\\a b$c.txt')).toBe('a-b-c.txt');
    expect(safeFileName('..')).toBe('output.txt');
    expect(safeFileName('.zshrc')).toBe('zshrc');
  });

  it('anything else, or nothing, is output.txt; a long name is cut', () => {
    expect(safeFileName('')).toBe('output.txt');
    expect(safeFileName(42 as never)).toBe('output.txt');
    expect(safeFileName('a'.repeat(500))).toHaveLength(100);
  });

  it('32 MB is the most a save takes', () => {
    expect(SAVE_TEXT_MAX).toBe(32 * 1024 * 1024);
  });

  it('measured in UTF-8 bytes, as the file will be (the same count as Buffer.byteLength)', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a\u0301b€😀x', '\uD800 lone', 'end \uDC00']) expect(utf8Bytes(s), s).toBe(Buffer.byteLength(s));
    expect(utf8Bytes('é'.repeat(SAVE_TEXT_MAX / 2 + 1))).toBeGreaterThan(SAVE_TEXT_MAX); // fewer characters than the limit, more bytes
  });
});
