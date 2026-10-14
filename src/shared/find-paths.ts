/**
 * File paths in one printed terminal line, for ⌘-click (spec feature 11). A printed line is untrusted and forgeable at any length,
 * so only its head is read, the matches are capped, and every pattern runs on one space-separated word at a time (no pattern can
 * backtrack across the line). Finding a path opens nothing: the app checks that it exists and only reveals it or hands it to an editor.
 */

export interface FoundPath {
  /** Where the match (with its `:line:col`) starts and ends in the line (end exclusive). */
  start: number;
  end: number;
  /** As printed: absolute, `~/…`, or relative (the window resolves it against the session's folder). */
  path: string;
  line?: number;
  col?: number;
}

const LINE_HEAD = 4096;
const MAX_MATCHES = 20;
/** Words: runs between spaces, quotes and brackets. */
const WORD = /[^\s"'`<>()[\]{}|]+/g;
const SUFFIX = /:(\d{1,7})(?::(\d{1,7}))?$/;
/** `/x`, `~/x`, `./x`, `../x`: a path by its start (not a lone `/` or a `//` comment). */
const ANCHORED = /^(?:~|\.\.?)?\/[^/]/;
/** `file.ext`, `dir/file.ext`: a path by its extension (1–8 letters or digits, at least one letter: not `3.14`, not `v1.2.3`). */
const NAMED = /^[\w@%+=-][\w.@%+=-]*(?:\/[\w.@%+=-]+)*\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}$/;
/** A bare `name.ext` (no folder, no `:line`) is a path only with one of these extensions: prose has `e.g.`, `example.com`, `x.io`. */
const SOURCE_EXT = new Set('ts tsx js jsx mjs cjs json md py rb go rs java kt swift c h cc cpp hpp css scss html yml yaml toml txt sh zsh log lock'.split(' '));
/** Names of projects, not files. */
const PROSE = /^(?:node|vue|next|nuxt|react|express|three|chart|d3|ember|angular|backbone|deno|bun)\.js$/i;
const bareOk = (p: string) => SOURCE_EXT.has(p.slice(p.lastIndexOf('.') + 1).toLowerCase()) && !PROSE.test(p);

export function findPaths(line: string): FoundPath[] {
  if (typeof line !== 'string') return [];
  const head = line.slice(0, LINE_HEAD);
  const out: FoundPath[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(head); m && out.length < MAX_MATCHES; m = WORD.exec(head)) {
    let word = m[0];
    let start = m.index;
    if (word.includes('://')) continue; // never inside a URL (the web-links addon has those)
    const eq = word.lastIndexOf('='); // `--out=src/a.ts`, `key=value.json`: the value
    const lead = /^-*/.exec(word.slice(eq + 1))![0].length; // `-lib/a.ts`: not the option's dash
    start += eq + 1 + lead;
    word = word.slice(eq + 1 + lead);
    while (word && '.,;:'.includes(word[word.length - 1]!)) word = word.slice(0, -1);
    const suffix = SUFFIX.exec(word);
    const path = suffix ? word.slice(0, suffix.index) : word;
    if (!ANCHORED.test(path) && !(NAMED.test(path) && (path.includes('/') || suffix || bareOk(path)))) continue;
    const found: FoundPath = { start, end: start + word.length, path };
    if (suffix) {
      found.line = Number(suffix[1]);
      if (suffix[2] !== undefined) found.col = Number(suffix[2]);
    }
    out.push(found);
  }
  return out;
}
