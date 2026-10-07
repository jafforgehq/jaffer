import { describe, expect, it } from 'vitest';
import { isAppUrl, isWebUrl, osc52Provider } from '../src/shared/window-policy';

const INDEX = 'file:///Applications/Jaffer.app/Contents/Resources/app/dist/renderer/index.html';

describe('isAppUrl', () => {
  it('is the app page, whatever query or fragment it carries', () => {
    expect(isAppUrl(INDEX, INDEX)).toBe(true);
    expect(isAppUrl(`${INDEX}?renderer=dom`, INDEX)).toBe(true);
    expect(isAppUrl(`${INDEX}#x`, INDEX)).toBe(true);
  });

  it('is not any other page: a file dropped on the window must not get the daemon bridge', () => {
    expect(isAppUrl('file:///Users/me/Downloads/evil.html', INDEX)).toBe(false);
    expect(isAppUrl('file:///Applications/Jaffer.app/Contents/Resources/app/dist/renderer/other.html', INDEX)).toBe(false);
    expect(isAppUrl('file:///Applications/Jaffer.app/Contents/Resources/app/dist/renderer/index.html/../../evil.html', INDEX)).toBe(false);
    expect(isAppUrl('file:///', INDEX)).toBe(false);
  });

  it('is not a web page, a scheme of another kind, nothing, or something that is not a URL', () => {
    expect(isAppUrl('https://example.com/index.html', INDEX)).toBe(false);
    expect(isAppUrl('data:text/html,<script>alert(1)</script>', INDEX)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', INDEX)).toBe(false);
    expect(isAppUrl(undefined, INDEX)).toBe(false);
    expect(isAppUrl('', INDEX)).toBe(false);
    expect(isAppUrl('not a url', INDEX)).toBe(false);
    expect(isAppUrl(INDEX, 'not a url either')).toBe(false);
  });

  it('copes with spaces and other characters in the path of the app, encoded one way or the other', () => {
    const odd = 'file:///Users/me/My%20Apps/Jaffer.app/Contents/Resources/app/dist/renderer/index.html';
    expect(isAppUrl(odd, odd)).toBe(true);
    expect(isAppUrl('file:///Users/me/My Apps/Jaffer.app/Contents/Resources/app/dist/renderer/index.html', odd)).toBe(true);
  });
});

describe('isWebUrl', () => {
  it('is http and https only', () => {
    expect(isWebUrl('https://example.com')).toBe(true);
    expect(isWebUrl('HTTP://example.com')).toBe(true);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('mailto:me@example.com')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('ftp://example.com')).toBe(false);
  });
});

describe('osc52Provider: a program may copy to the clipboard, never read it', () => {
  it('always answers a read request with nothing, so what you copied stays yours', async () => {
    const p = osc52Provider(async () => undefined);
    expect(await p.readText('c')).toBe('');
    expect(await p.readText('p')).toBe('');
    expect(await p.readText('s')).toBe('');
  });

  it('writes the main clipboard, and ignores the selections of other kinds', async () => {
    const written: string[] = [];
    const p = osc52Provider(async (t) => void written.push(t));
    await p.writeText('c', 'copied by ssh');
    await p.writeText('p', 'primary selection');
    await p.writeText('s', 'secondary selection');
    expect(written).toEqual(['copied by ssh']);
  });

  it('reports a failed write to its caller rather than hiding it', async () => {
    const p = osc52Provider(async () => {
      throw new Error('clipboard denied');
    });
    await expect(p.writeText('c', 'x')).rejects.toThrow('clipboard denied');
  });
});
