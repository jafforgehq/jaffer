const MAX_OUTSIDE = 48;

/**
 * A file path as the live panel shows it: relative to where Claude is working when it is inside that directory, and
 * abbreviated to its last three segments when it is long and elsewhere, so the file name is always visible.
 */
export function shortToolPath(p: string, cwd: string): string {
  if (!p.startsWith('/')) return p;
  const base = cwd.replace(/\/+$/, '');
  if (base && p.startsWith(`${base}/`)) return p.slice(base.length + 1);
  if (p.length <= MAX_OUTSIDE) return p;
  return `…/${p.split('/').filter(Boolean).slice(-3).join('/')}`;
}
