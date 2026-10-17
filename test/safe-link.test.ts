import { describe, expect, it } from 'vitest';
import { safeLinkUrl } from '../src/shared/safe-link';

describe('safeLinkUrl: which terminal links may open in the browser', () => {
  it('lets http and https through, any case of the scheme', () => {
    expect(safeLinkUrl('https://example.com/x?a=1#top')).toBe('https://example.com/x?a=1#top');
    expect(safeLinkUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(safeLinkUrl('HTTPS://Example.com/a')).toBe('https://example.com/a');
  });
  it('refuses every other scheme', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'vbscript:x', 'ftp://example.com/', 'ssh://host', 'vscode://file/x', 'x-custom://a', 'mailto:a@b.c', 'about:blank'])
      expect(safeLinkUrl(u), u).toBeNull();
  });
  it('refuses a relative or broken link, an empty one, and one that is not text', () => {
    for (const u of ['/etc/passwd', 'example.com', '//example.com/x', 'https://', '', ' ', '../x']) expect(safeLinkUrl(u), u).toBeNull();
    expect(safeLinkUrl(undefined as unknown as string)).toBeNull();
    expect(safeLinkUrl(7 as unknown as string)).toBeNull();
  });
  it('refuses a link that carries a user name or a password', () => {
    expect(safeLinkUrl('https://user:pass@example.com/')).toBeNull();
    expect(safeLinkUrl('https://user@example.com/')).toBeNull();
    expect(safeLinkUrl('https://good.com@evil.com/')).toBeNull();
  });
  it('refuses more than 2048 characters, accepts exactly 2048', () => {
    const base = 'https://example.com/';
    expect(safeLinkUrl(base + 'a'.repeat(2048 - base.length))).not.toBeNull();
    expect(safeLinkUrl(base + 'a'.repeat(2049 - base.length))).toBeNull();
  });
  it('refuses control characters, line breaks and hidden characters', () => {
    for (const u of ['https://example.com/\u0000x', 'https://example.com/\nx', 'https://example.com/\u001bx', 'https://exa\tmple.com/', 'https://example.com/a b', 'https://example.com/\u007fx', 'https://example.com/‮x', 'https://example.com/​x'])
      expect(safeLinkUrl(u), JSON.stringify(u)).toBeNull();
  });
});
