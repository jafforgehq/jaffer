import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_PAGE_METHODS, NOT_ALLOWED, pageMayCall } from '../src/shared/page-methods';

/**
 * (1.4.1) The daemon methods the window's page may call through main (`jaffer:call`) are a fixed list, kept in step with the
 * renderer's own `call('…')` sites: every method the renderer names is on it, and every entry on it is one the renderer names.
 */

const root = path.resolve(__dirname, '..');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const read = (f: string) => fs.readFileSync(f, 'utf8');

/** `call('x'`, `.call<T>('x'`, `.call<{ a: Record<string, number> }>(\n 'x'`: the method names passed as a string literal. */
const CALL = /\bcall\s*(?:<[^()]*?>)?\s*\(\s*\\?['"`]([a-zA-Z][\w.]*)\\?['"`]/g;
const named = (src: string) => [...src.matchAll(CALL)].map((m) => m[1]!);

/** Methods the page must never reach: the hook CLI's, a client's own hello, the screen read and the daemon's end. */
const NEVER = ['hello', 'claude.event', 'claude.approval', 'session.snapshot', 'app.shutdown'];
/**
 * Called through `window.jaffer.call` only by the UI tests, through the dev bridge (which stands in for main and has no list):
 * `hello` (the tests check the daemon), `claude.event` (the tests play Claude Code's hooks).
 */
const TEST_ONLY = ['hello', 'claude.event'];

describe('the page call allow-list', () => {
  const rendererFiles = files(path.join(root, 'src/renderer'));
  const used = new Set(rendererFiles.flatMap((f) => named(read(f))));

  it('the scan finds the renderer calls (a nested generic, a call on the next line)', () => {
    expect(named(`call<{ events: Record<string, number | null> }>('claude.hooks', {})`)).toEqual(['claude.hooks']);
    expect(named(`window.jaffer\n      .call<{ tokens?: unknown }>('claude.usage5h', {})`)).toEqual(['claude.usage5h']);
    expect(used.size).toBeGreaterThan(20);
  });

  it('every method the renderer calls is allowed', () => {
    for (const m of used) expect(ALLOWED_PAGE_METHODS.has(m), m).toBe(true);
  });

  it('every allowed method is one the renderer calls (the list cannot grow stale)', () => {
    for (const m of ALLOWED_PAGE_METHODS) expect(used.has(m), m).toBe(true);
  });

  it('the renderer names every method as a literal (a computed name could not be checked)', () => {
    let helpers = 0;
    for (const f of rendererFiles) {
      const src = read(f);
      for (const m of src.matchAll(/\bcall\s*(?:<[^()]*?>)?\s*\(/g)) {
        if (/^\s*\\?['"`]/.test(src.slice(m.index! + m[0].length))) continue;
        // only the one-line helpers that pass their argument on (and the bridge's type)
        const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!));
        expect(line, path.relative(root, f)).toMatch(/^const call = <T = any,>\(m: string, p\?: unknown\) => window\.jaffer\.call<T>\(m, p\);$|^\s*call<T = any>\(method: string, params\?: unknown\): Promise<T>;$/);
        helpers++;
      }
    }
    expect(helpers).toBeGreaterThan(0);
  });

  it('never lets the page say hello, play a hook, answer for the hook, read the screen or end the daemon', () => {
    for (const m of NEVER) {
      expect(ALLOWED_PAGE_METHODS.has(m), m).toBe(false);
      expect(pageMayCall(m)).toBe(false);
    }
    for (const m of [undefined, null, 42, {}, '', 'config.patch ', 'CONFIG.PATCH', '__proto__', 'constructor', 'toString']) expect(pageMayCall(m)).toBe(false);
    expect(pageMayCall('pty.write')).toBe(true);
    expect(NOT_ALLOWED).toBe('Not allowed.');
  });

  it('every method the UI tests call through the bridge is allowed or test-only', () => {
    const e2e = files(path.join(root, 'test/e2e'));
    // (what the tests' own node side asks the daemon, `c.call('app.shutdown')`, does not go through the page)
    const viaPage = (src: string) => [...src.matchAll(/\bjaffer\s*\.call\s*(?:<[^()]*?>)?\s*\(\s*\\?['"`]([a-zA-Z][\w.]*)\\?['"`]/g)].map((m) => m[1]!);
    const seen = new Set([...e2e, path.join(root, 'src/dev/bridge.ts')].flatMap((f) => viaPage(read(f))));
    expect(seen.size).toBeGreaterThan(5);
    for (const m of seen) expect(ALLOWED_PAGE_METHODS.has(m) || TEST_ONLY.includes(m), m).toBe(true);
    for (const m of TEST_ONLY) expect(ALLOWED_PAGE_METHODS.has(m), m).toBe(false);
  });

  it('main checks the list before it forwards a call, and its smoke test asks the daemon itself', () => {
    const main = read(path.join(root, 'src/main/main.ts'));
    const handler = main.slice(main.indexOf("ipcMain.handle('jaffer:call'"), main.indexOf("ipcMain.handle('jaffer:open-external'"));
    expect(handler).toMatch(/if \(!pageMayCall\(method\)\) throw new Error\(NOT_ALLOWED\);[\s\S]*client\.call\(method/);
    // the smoke test runs the page's bridge with allowed methods only (and checks that hello is refused)
    for (const m of named(main.slice(main.indexOf('async function smokeTest'))).filter((x) => /^[a-z]+\./.test(x) || x === 'hello')) {
      if (m === 'hello' || m === 'session.snapshot') continue; // (asked of the daemon directly, or the refusal check)
      expect(ALLOWED_PAGE_METHODS.has(m), m).toBe(true);
    }
  });
});
