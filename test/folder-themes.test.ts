import { describe, expect, it } from 'vitest';
import { parseFolderThemes, themeForFolder } from '../src/shared/folder-themes';

const ids = new Set(['night', 'ember', 'paper']);
const resolve = (n: string) => (ids.has(n.toLowerCase()) ? n.toLowerCase() : undefined);
const home = '/Users/me';

describe('parseFolderThemes', () => {
  it('reads folder=theme lines, expands ~, accepts any case, and skips bad ones', () => {
    const l = parseFolderThemes(['~/code/prod=Ember', '/srv/app/=paper', 'nope', 'relative/dir=night', '~/x=unknown', '=night', 5, '~/code/prod=night'], home, resolve);
    expect(l).toEqual([
      { dir: '/Users/me/code/prod', theme: 'ember' },
      { dir: '/srv/app', theme: 'paper' },
    ]);
  });
  it('keeps at most 20 and copes with a non-list', () => {
    expect(parseFolderThemes(Array.from({ length: 50 }, (_, i) => `/d${i}=night`), home, resolve)).toHaveLength(20);
    expect(parseFolderThemes('x', home, resolve)).toEqual([]);
    expect(parseFolderThemes(undefined, home, resolve)).toEqual([]);
  });
});

describe('themeForFolder', () => {
  const list = parseFolderThemes(['/a=night', '/a/b=ember', '/'.repeat(1) + 'z=paper'], home, resolve);
  it('picks the most specific folder that is the cwd or a parent', () => {
    expect(themeForFolder(list, '/a')).toBe('night');
    expect(themeForFolder(list, '/a/x/y')).toBe('night');
    expect(themeForFolder(list, '/a/b')).toBe('ember');
    expect(themeForFolder(list, '/a/b/c')).toBe('ember');
  });
  it('does not match a sibling with the same prefix, nor a missing or relative cwd', () => {
    expect(themeForFolder(list, '/ab')).toBeUndefined();
    expect(themeForFolder(list, '/zz')).toBeUndefined();
    expect(themeForFolder(list, '')).toBeUndefined();
    expect(themeForFolder(list, undefined)).toBeUndefined();
    expect(themeForFolder(list, 'a/b')).toBeUndefined();
  });
});
