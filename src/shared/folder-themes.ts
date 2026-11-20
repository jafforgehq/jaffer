/**
 * Theme by folder (1.7.0, `appearance.folderThemes`): the person's own lines `"<folder>=<theme>"`, e.g. `~/code/prod-api=Ember`. While the
 * focused terminal is in that folder (or below it) the window wears that theme; nothing else changes and nothing is written. Pure.
 */
const MAX = 20;

/** A folder with `~` expanded and no trailing slash (a loop, not a regex over slashes). */
function folder(raw: string, home: string): string {
  if ((raw === '~' || raw.startsWith('~/')) && !home) return ''; // (no home folder known: a `~` line means nothing)
  const p = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw;
  if (p.length <= 1) return p;
  let e = p.length;
  while (e > 0 && p[e - 1] === '/') e--;
  return p.slice(0, e) || '/';
}

export interface FolderTheme {
  dir: string;
  theme: string;
}

/**
 * The lines' folders and themes: an absolute (or `~`) folder, the last `=`, a theme `resolve` knows (by id or name, any case: it returns
 * the id or undefined). Bad lines are skipped, the first line per folder wins, at most 20.
 */
export function parseFolderThemes(lines: unknown, home: string, resolve: (name: string) => string | undefined): FolderTheme[] {
  const out: FolderTheme[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string' || line.length > 4200) continue;
    const eq = line.lastIndexOf('=');
    if (eq < 0) continue;
    const raw = line.slice(0, eq).trim();
    const theme = resolve(line.slice(eq + 1).trim());
    if (!raw || !theme) continue;
    const dir = folder(raw, home);
    if (!dir.startsWith('/') || dir.length > 4096 || out.some((f) => f.dir === dir)) continue;
    out.push({ dir, theme });
    if (out.length >= MAX) break;
  }
  return out;
}

/** The theme for a working folder: the most specific entry whose folder is it or one of its parents. */
export function themeForFolder(list: FolderTheme[], cwd: string | undefined | null): string | undefined {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined;
  let best: FolderTheme | undefined;
  for (const f of list) {
    const inside = f.dir === '/' || cwd === f.dir || cwd.startsWith(f.dir + '/');
    if (inside && (!best || f.dir.length > best.dir.length)) best = f;
  }
  return best?.theme;
}
