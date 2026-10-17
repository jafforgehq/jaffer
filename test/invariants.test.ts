import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * (1.4.1) Source scans for rules of CLAUDE.md that no other test can see: each one fails when new code breaks the rule, and its
 * allow-list names the places that are known to keep it. Comments are stripped first (a rule written in a comment is not a use).
 */

const root = path.resolve(__dirname, '..');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs|cjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const rel = (f: string) => path.relative(root, f);

/** The code without its comments; strings, template literals and regular expressions are kept as they are, and lines keep their numbers. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let last = ''; // the last character of code that is not a space, to tell a regular expression from a division
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i += body.length;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd())))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === '\\') j += 2;
        else if (c === '/' && d === '[') (cls = true), j++;
        else if (c === '/' && d === ']') (cls = false), j++;
        else if (d === c && !cls) break;
        else if (d === '\n' && c !== '`') break; // (not a string or a regular expression after all)
        else j++;
      }
      out += src.slice(i, j + 1);
      last = c;
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

const SRC = files(path.join(root, 'src')).filter((f) => !f.includes(`${path.sep}generated${path.sep}`));
const code = new Map(SRC.map((f) => [rel(f), stripComments(fs.readFileSync(f, 'utf8'))]));
/** Every match of `re` in the code, as `file:line`. */
const hits = (re: RegExp, only?: (file: string) => boolean): string[] => {
  const out: string[] = [];
  for (const [f, src] of code) {
    if (only && !only(f)) continue;
    for (const m of src.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) out.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
  return out;
};
const perFile = (list: string[]) => list.reduce<Record<string, number>>((a, h) => ((a[h.split(':')[0]!] = (a[h.split(':')[0]!] ?? 0) + 1), a), {});

describe('stripComments', () => {
  it('drops line and block comments, keeps strings, templates and regular expressions (with // or /* inside)', () => {
    const src = "const a = 'http://x'; // gone\nconst r = /\\/\\/[/*]/g; /* gone\n too */ const t = `a // b`;\nconst d = 4 / 2 / 1; // gone";
    const out = stripComments(src);
    expect(out).toContain("'http://x'");
    expect(out).toContain('/\\/\\/[/*]/g');
    expect(out).toContain('`a // b`');
    expect(out).toContain('4 / 2 / 1');
    expect(out).not.toContain('gone');
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('scans the real sources', () => {
    expect(code.size).toBeGreaterThan(100);
    expect(code.get('src/main/main.ts')).toContain("ipcMain.handle('jaffer:call'");
  });
});

describe('invariants of CLAUDE.md', () => {
  // "any new dialog must go through that wrapper, never `electron.dialog` directly, or a sheet would hide its own window" (drop-down mode)
  it('every dialog goes through the counting wrapper in main.ts', () => {
    expect(perFile(hits(/\belectronDialog\.show\w+/))).toEqual({ 'src/main/main.ts': 4 }); // (the two lines of the wrapper, each naming it twice)
    expect(code.get('src/main/main.ts')).toMatch(/showMessageBox: counted\(electronDialog\.showMessageBox\.bind\(electronDialog\)\)/);
    expect(code.get('src/main/main.ts')).toMatch(/showSaveDialog: counted\(electronDialog\.showSaveDialog\.bind\(electronDialog\)\)/);
    // `dialog` from electron is imported only under that name, only there, and electron's own dialog is never reached another way
    for (const [f, src] of code) {
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'electron'/g)) {
        const names = m[1]!.split(',').map((s) => s.trim());
        for (const n of names.filter((x) => /^dialog\b/.test(x))) expect(`${f}: ${n}`).toBe('src/main/main.ts: dialog as electronDialog');
      }
    }
    expect(hits(/\belectron\.dialog\b|require\(\s*'electron'\s*\)\.dialog|\bremote\.dialog\b/)).toEqual([]);
  });

  // "Nothing printed in the terminal is ever opened or run: ... never `shell.openPath`" (only Jaffer's own folder and log)
  it('shell.openPath opens only Jaffer’s own folder and log', () => {
    const calls = [...code].flatMap(([f, src]) => [...src.matchAll(/\bshell\.openPath\(([^)]*)\)/g)].map((m) => `${f}: ${m[1]}`));
    expect(calls.sort()).toEqual(['src/main/main.ts: paths.home', 'src/main/main.ts: paths.home', 'src/main/main.ts: paths.logFile']);
    expect(hits(/\bopenPath\b(?!\s*[:(])/, (f) => f.startsWith('src/main/'))).toEqual([]); // (never passed on as a value)
  });

  // "The page may use these IPC channels of main, and each checks `trusted(e)` (the sender is the app's own page)"
  it('every ipcMain.handle checks trusted( within its first lines', () => {
    const handlers = hits(/\bipcMain\.handle\(/);
    expect(handlers.length).toBeGreaterThanOrEqual(13);
    for (const h of handlers) {
      const [f, line] = h.split(':');
      const body = code.get(f!)!.split('\n').slice(Number(line) - 1, Number(line) + 5).join('\n');
      expect(body, h).toMatch(/\btrusted\(e\)/);
    }
    expect(hits(/\bipcMain\.on\(|\bipcMain\.handleOnce\(/)).toEqual([]);
  });

  // "`redactText` itself throws (`RangeError`) on a multi-megabyte single-run string: every caller that redacts untrusted text clips it
  // to `4 * COMMAND_HEAD` first". A new call site fails here until it is added, with a note on how its input is bounded.
  it('redactText( is called only from the known, bounded call sites', () => {
    const KNOWN: Record<string, number> = {
      'src/core/claude/approvals.ts': 2, // the tool name sliced to 4 * MAX_TOOL; the line cut to its head (COMMAND_HEAD) first
      'src/core/claude/explain.ts': 2, // the reply collected up to 4 * COMMAND_HEAD; the helper's answer read up to OUT_MAX * 4
      'src/core/claude/history.ts': 1, // the title sliced to COMMAND_HEAD
      'src/core/claude/setup.ts': 1, // sliced to 4 * COMMAND_HEAD
      'src/core/claude/watcher.ts': 2, // sliced to 20 000; a path of at most MAX_PATH (1024)
      'src/renderer/actions.ts': 1, // a pinned line: the first line of a block's command, from safeCommand's head
      'src/renderer/components/TerminalView.tsx': 1, // the first line of a paste, cut by firstLine
      'src/renderer/state.ts': 2, // the cwd sliced to 4 * COMMAND_HEAD; safeCommand's head (COMMAND_HEAD)
      'src/shared/notify-policy.ts': 1, // the command's head (COMMAND_HEAD)
      'src/shared/recent-commands.ts': 1, // a command of at most 4 * COMMAND_HEAD (longer ones are never kept)
      'src/shared/redact.ts': 1, // its own definition
      'src/shared/resume-action.ts': 1, // the busy command, from the daemon's bounded command line
    };
    expect(perFile(hits(/\bredactText\(/))).toEqual(KNOWN);
  });

  // "Every child uses an argv array (no shell)" (git status, `claude`, caffeinate, launchctl): no shell, ever
  it('no child process runs through a shell', () => {
    expect(hits(/\bshell\s*:\s*(true|['"`])/)).toEqual([]);
    expect(hits(/(?<![.\w])(exec|execSync)\s*\(/)).toEqual([]);
    for (const [f, src] of code) {
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(node:)?child_process'/g)) {
        for (const n of m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!)) expect(['execFile', 'spawn', 'ChildProcess', 'SpawnOptions'], `${f}: ${n}`).toContain(n);
      }
    }
    expect(hits(/require\(\s*'(node:)?child_process'\s*\)/)).toEqual([]);
  });

  // "Jaffer runs on Claude subscriptions only: there is no Anthropic API key anywhere ... and `ANTHROPIC_API_KEY` is ignored"
  it('ANTHROPIC_API_KEY appears only where it is removed from an environment', () => {
    const all = hits(/ANTHROPIC_API_KEY/);
    const removed = hits(/\bdelete\s+\w+\.ANTHROPIC_API_KEY\b/);
    expect(all.length).toBeGreaterThan(0);
    expect(all).toEqual(removed);
  });

  // "never read Claude's credential files or keychain item": `~/.claude.json` is opened nowhere; setup.ts names it only to refuse it
  it('.claude.json is named only by setup.ts’s guard that refuses it', () => {
    expect(hits(/\.claude\.json/)).toEqual(hits(/\.claude\.json/, (f) => f === 'src/core/claude/setup.ts'));
    expect(hits(/\.claude\.json/).length).toBe(1);
    expect(code.get('src/core/claude/setup.ts')).toMatch(/if \(path\.basename\(r\)\.toLowerCase\(\)\.startsWith\('\.claude\.json'\)\) return undefined;/);
    expect(hits(/readFileSync\([^)]*claude\.json/)).toEqual([]);
  });

  // "no `innerHTML` or `eval` sinks in the renderer" (the release notes are rendered by mini-md into elements, never as HTML)
  it('the renderer has no HTML or code sinks', () => {
    expect(hits(/\binnerHTML\b|\bouterHTML\b|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write\b|(?<![.\w])eval\s*\(|\bnew\s+Function\b/, (f) => f.startsWith('src/renderer/'))).toEqual([]);
  });
});
