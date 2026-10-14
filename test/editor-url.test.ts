import { describe, expect, it } from 'vitest';
import { EDITOR_SCHEMES, editorUrl } from '../src/shared/editor-url';

describe('editorUrl: an editor link for a file, from the template in Settings', () => {
  it('fills {path}, {line} and {col}; line and column default to 1', () => {
    expect(editorUrl('vscode://file/{path}:{line}:{col}', '/Users/me/app/src/a.ts', 12, 3)).toBe('vscode://file//Users/me/app/src/a.ts:12:3');
    expect(editorUrl('cursor://file{path}:{line}:{col}', '/a/b.ts')).toBe('cursor://file/a/b.ts:1:1');
    expect(editorUrl('idea://open?file={path}&line={line}', '/a/b.kt', 7)).toBe('idea://open?file=/a/b.kt&line=7');
  });

  it('encodes the path (keeping its slashes), so nothing in a file name changes the link', () => {
    expect(editorUrl('zed://file{path}', '/My Code/a#b?c&d=e%f.txt')).toBe('zed://file/My%20Code/a%23b%3Fc%26d%3De%25f.txt');
    expect(editorUrl('subl://open?url=file://{path}', '/x/ü.md')).toBe('subl://open?url=file:///x/%C3%BC.md');
  });

  it('allows only the editor schemes', () => {
    expect([...EDITOR_SCHEMES]).toEqual(['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'idea', 'subl', 'txmt']);
    for (const s of EDITOR_SCHEMES) expect(editorUrl(`${s}://x{path}`, '/a')).toBe(`${s}://x/a`);
    expect(editorUrl('VSCode://file/{path}', '/a')).toBe('VSCode://file//a');
    for (const t of ['file://{path}', 'https://evil.example/{path}', 'javascript:alert(1)//{path}', 'x-terminal://{path}', 'vscodex://{path}', ' {path}', 'vscode{path}'])
      expect(editorUrl(t, '/a'), t).toBeNull();
  });

  it('null for an empty template, a template without {path}, or a path that is not absolute', () => {
    expect(editorUrl('', '/a')).toBeNull();
    expect(editorUrl('vscode://file/', '/a')).toBeNull();
    expect(editorUrl('vscode://file/{path}', 'a/b')).toBeNull();
    expect(editorUrl(undefined as unknown as string, '/a')).toBeNull();
  });

  it('line and column only as positive whole numbers', () => {
    expect(editorUrl('vscode://file/{path}:{line}:{col}', '/a', -2, Number.NaN)).toBe('vscode://file//a:1:1');
    expect(editorUrl('vscode://file/{path}:{line}', '/a', 1.5)).toBe('vscode://file//a:1');
  });
});
