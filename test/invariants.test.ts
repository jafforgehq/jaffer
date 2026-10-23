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
/**
 * The channels of `ipcMain.handle(` whose handler does not call `trusted(`: each handler's body is the call's own parentheses
 * (strings skipped), cut at the next `ipcMain.handle(` whatever happens.
 */
function untrustedHandlers(src: string): string[] {
  const out: string[] = [];
  const starts = [...src.matchAll(/\bipcMain\.handle\(/g)].map((m) => m.index!);
  for (const [k, at] of starts.entries()) {
    const limit = starts[k + 1] ?? src.length;
    let depth = 0;
    let end = limit;
    for (let i = at + 'ipcMain.handle'.length; i < limit; i++) {
      const c = src[i]!;
      if (c === "'" || c === '"' || c === '`') {
        for (i++; i < limit && src[i] !== c; i++) if (src[i] === '\\') i++;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const body = src.slice(at, end);
    if (!/\btrusted\(e\)/.test(body)) out.push(/^ipcMain\.handle\(\s*'([^']*)'/.exec(body)?.[1] ?? `@${at}`);
  }
  return out;
}
/** How a source could start a child through a shell (CLAUDE.md: every child is an argv array, no shell). Empty when it cannot. */
function shellViolations(src: string): string[] {
  const out: string[] = [];
  const CP = `['"\`](?:node:)?child_process['"\`]`;
  // only named imports of execFile and spawn (and types): no default or namespace import that could reach exec, no require
  for (const m of src.matchAll(new RegExp(`\\bimport\\s+([^;]*?)\\s+from\\s*${CP}`, 'g'))) {
    if (!/^(type\s+)?\{[^}]*\}$/.test(m[1]!)) out.push(m[0]);
    else for (const n of m[1]!.replace(/^type\s+/, '').slice(1, -1).split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!).filter(Boolean)) if (!['execFile', 'spawn', 'ChildProcess', 'SpawnOptions'].includes(n)) out.push(n);
  }
  out.push(...(src.match(new RegExp(`\\b(require|import)\\s*\\(\\s*${CP}`, 'g')) ?? []));
  out.push(...(src.match(/(?<![.\w])(exec|execSync)\s*\(/g) ?? []));
  // no `shell:` option but `false` in a file that starts children, and none passed straight into a spawn anywhere
  if (new RegExp(CP).test(src)) out.push(...(src.match(/\bshell\s*:(?!\s*false\b)/g) ?? []));
  out.push(...(src.match(/\b(spawn|execFile|fork|spawnSync|execFileSync)\s*\([^;]*?\bshell\s*:(?!\s*false\b)/g) ?? []));
  return out;
}
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

  // "Permission handlers (1.4.1): the window's session grants `clipboard-sanitized-write`, and (voice) `media` for audio only while
  // `permissions.voice` is on (`pageMayUseMic`), only to the app's own webContents; every other permission, `clipboard-read` included, is refused
  // in both the request and the check handler. Don't add another."
  it('the permission handlers grant only clipboard-sanitized-write and, for audio with voice on, media', () => {
    expect(hits(/\bsetPermissionRequestHandler\(/)).toHaveLength(1);
    expect(hits(/\bsetPermissionCheckHandler\(/)).toHaveLength(1);
    expect(hits(/\bsetDevicePermissionHandler\(|\bsetDisplayMediaRequestHandler\(|\bsetBluetoothPairingHandler\(|\bsetUSBProtocolHandler\(/)).toEqual([]);
    const main = code.get('src/main/main.ts')!;
    const decide = main.match(/const pagePermission = ([^\n]*);\n/)?.[1];
    expect(decide, 'the one decision function').toBeTruthy();
    expect([...decide!.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])).toEqual(['clipboard-sanitized-write']); // (the only permission named here; the microphone goes through pageMayUseMic)
    expect(decide).toMatch(/pageMayUseMic\(/);
    const mic = code.get('src/shared/voice-permission.ts')!; // (the only other place that names a permission, and the only kind it allows)
    expect([...mic.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])).toEqual(['media', 'audio']);
    expect(decide).toMatch(/wc === win\.webContents/); // (only the app's own page)
    // both handlers only ever answer with that function: no `true`, no other test
    expect(main).toMatch(/setPermissionRequestHandler\(\(wc, permission, cb, details\) => cb\(pagePermission\(wc, permission, 'mediaTypes' in details \? details\.mediaTypes : undefined\)\)\);/);
    expect(main).toMatch(/setPermissionCheckHandler\(\(wc, permission, _origin, details\) => pagePermission\(wc, permission, details\.mediaType \? \[details\.mediaType\] : undefined\)\);/);
    expect(main.match(/\bpagePermission\b/g)).toHaveLength(3); // (the definition and the two handlers: no other use)
  });

  // "`jaffer:open-external` (http(s) only) ... Nothing printed in the terminal is ever run, and only web links are opened": every
  // `shell.openExternal(` call site is known (file and argument); a new one fails until it is added here with the reason it is safe
  it('shell.openExternal is called only from the known sites', () => {
    const calls = [...code].flatMap(([f, src]) => [...src.matchAll(/\bshell\.openExternal\(([^)]*)\)/g)].map((m) => `${f}: ${m[1]}`));
    expect(calls.sort()).toEqual(
      [
        'src/main/main.ts: RELEASES_URL', // (the update dialogs: a constant)
        'src/main/main.ts: RELEASES_URL',
        "src/main/main.ts: 'https://github.com/jafforgehq/jaffer'", // (the menu bar item's Help line: a constant)
        'src/main/main.ts: url', // (window.open and will-navigate: only after `isWebUrl(url)`)
        'src/main/main.ts: url',
        'src/main/main.ts: url', // (`jaffer:open-external`: only `/^https?:\/\//` after `trusted(e)`)
        'src/main/main.ts: url', // (`jaffer:open-path`: `editorUrl(...)`, whose scheme is on the editor allow-list)
      ].sort(),
    );
    expect(hits(/\bopenExternal\b(?!\s*[:(])/, (f) => f.startsWith('src/main/') && f !== 'src/main/preload.ts')).toEqual([]); // (never passed on as a value)
    const main = code.get('src/main/main.ts')!;
    expect(main).toMatch(/if \(isWebUrl\(url\)\) void shell\.openExternal\(url\);[^]*if \(isWebUrl\(url\)\) void shell\.openExternal\(url\);/);
    expect(main).toMatch(/trusted\(e\) && \/\^https\?:\\\/\\\/\/\.test\(url\)\) void shell\.openExternal\(url\)/);
  });

  // "The page may use these IPC channels of main, and each checks `trusted(e)` (the sender is the app's own page)"
  it('every ipcMain.handle calls trusted( in its own handler, and no IPC is taken in another way', () => {
    expect(hits(/\bipcMain\.handle\(/).length).toBeGreaterThanOrEqual(13);
    for (const [f, src] of code) expect(untrustedHandlers(src), f).toEqual([]);
    expect(hits(/\bipcMain\.(on|once|addListener|prependListener|prependOnceListener|handleOnce)\(|\.ipc\.(handle|handleOnce|on|once|addListener)\(/)).toEqual([]);
  });

  it('(the rule itself) finds a handler whose own body lost its trusted( check, also when the next one still has one', () => {
    const main = code.get('src/main/main.ts')!;
    expect(untrustedHandlers(main)).toEqual([]);
    const at = main.indexOf("ipcMain.handle('jaffer:reveal'");
    const cut = main.indexOf('trusted(e)', at);
    const mutated = main.slice(0, cut) + 'true' + main.slice(cut + 'trusted(e)'.length);
    expect(untrustedHandlers(mutated)).toEqual(['jaffer:reveal']);
    expect(untrustedHandlers("ipcMain.handle('a', (e) => { if (x(')')) return; });\nconst later = trusted(e);")).toEqual(['a']);
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
      'src/shared/notify-policy.ts': 2, // the command's head (COMMAND_HEAD); a terminal's folder name, cut from the last 4 * COMMAND_HEAD of its cwd
      'src/shared/recent-commands.ts': 1, // a command of at most 4 * COMMAND_HEAD (longer ones are never kept)
      'src/shared/redact.ts': 1, // its own definition
      'src/shared/resume-action.ts': 1, // the busy command, from the daemon's bounded command line
      'src/shared/voice-text.ts': 1, // the reply clipped to 4 * COMMAND_HEAD first; only shorter text is redacted
    };
    expect(perFile(hits(/\bredactText\(/))).toEqual(KNOWN);
  });

  // "Every child uses an argv array (no shell)" (git status, `claude`, caffeinate, launchctl): no shell, ever
  it('no child process runs through a shell', () => {
    for (const [f, src] of code) expect(shellViolations(src), f).toEqual([]);
  });

  it('(the rule itself) catches a default or namespace import, a require, exec and a shell option', () => {
    for (const b of ["import cp from 'node:child_process';", "import * as cp from 'child_process';", "const cp = require('child_process');", "const { exec } = await import('node:child_process');", "import { exec } from 'node:child_process';", "import { execFile } from 'node:child_process';\nexecFile('ls', [], { shell: true });", "spawn('ls', [], { shell: '/bin/sh' })"])
      expect(shellViolations(b), b).not.toEqual([]);
    for (const ok of ["import { execFile, spawn, type ChildProcess } from 'node:child_process';\nspawn('ls', [], { shell: false, cwd });", "interface Cfg { shell: { path: string } }"]) expect(shellViolations(ok), ok).toEqual([]);
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
