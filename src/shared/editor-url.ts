/**
 * The link that opens a file in an editor, from the template in Settings → Terminal → Open file links in (spec feature 11), such as
 * `vscode://file/{path}:{line}:{col}`. Only editor schemes are allowed: a template can never make a printed path open a web page, a
 * `file://` URL or anything else that could run. The path is encoded segment by segment (its slashes kept), so no character in a
 * file name can change the link around it.
 */

export const EDITOR_SCHEMES = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'zed', 'idea', 'subl', 'txmt'] as const;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

export function editorUrl(template: string, abs: string, line?: number, col?: number): string | null {
  if (typeof template !== 'string' || typeof abs !== 'string' || !abs.startsWith('/') || !template.includes('{path}')) return null;
  const scheme = SCHEME.exec(template)?.[1]?.toLowerCase();
  if (!scheme || !(EDITOR_SCHEMES as readonly string[]).includes(scheme)) return null;
  const num = (n: number | undefined) => String(Number.isSafeInteger(n) && n! > 0 ? n : 1);
  const path = abs.split('/').map(encodeURIComponent).join('/');
  return template.replaceAll('{path}', path).replaceAll('{line}', num(line)).replaceAll('{col}', num(col));
}
