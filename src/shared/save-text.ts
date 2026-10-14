/** The most text "Save output…" writes, in UTF-8 bytes (as the file will be); the main process refuses more. */
export const SAVE_TEXT_MAX = 32 * 1024 * 1024;

/** The UTF-8 size of `s` (as `Buffer.byteLength`, which the renderer does not have): a lone surrogate is written as 3 bytes. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (n += 4), i++;
    else n += 3;
  }
  return n;
}

/** The name the save dialog suggests: the last part of a path only, letters, digits, `.`, `-` and `_`, no leading dot; else `output.txt`. */
export function safeFileName(name: unknown): string {
  if (typeof name !== 'string') return 'output.txt';
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return base || 'output.txt';
}
