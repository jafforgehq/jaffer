import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { cleanEnv, makeEnv, type TestEnv } from '../helpers/env';
import { fakeClaude } from '../helpers/fake-claude';
import { RpcClient } from '../../src/core/rpc';
import { sleep } from '../../src/shared/util';

/**
 * The main process, driven through the real Electron (playwright-core's `_electron`) against the built app (`npm run build` first) and
 * its real daemon and shell: the Electron wiring that the other tests only typecheck. Every run has its own HOME, JAFFER_HOME and
 * user-data dir (so neither your `~/.jaffer` nor a Jaffer you have open is touched: Electron allows one instance per data dir), a
 * stand-in `claude`, no hotkey, and the native dialogs answered by a stand-in (`answerDialogs`). macOS only; skipped without the
 * Electron binary (CI's Linux job does not download it).
 */
const root = path.resolve(__dirname, '..', '..');
const electronPath = (() => {
  try {
    const p = execFileSync(process.execPath, ['-p', "require('electron')"], { cwd: root, encoding: 'utf8', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } }).trim();
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
const runs = process.platform === 'darwin' && !!electronPath && fs.existsSync(path.join(root, 'dist', 'main', 'main.cjs'));

interface Run {
  e: TestEnv;
  app: ElectronApplication;
  page: Page;
  mainPid: number;
  daemonPid: number;
  client: RpcClient;
}
const live: Run[] = [];
const envs: TestEnv[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(ok: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

function ppid(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

function appArgs(e: TestEnv): { args: string[]; env: Record<string, string> } {
  const env = { ...cleanEnv(), HOME: e.userHome, JAFFER_HOME: e.home, JAFFER_NO_LAUNCHCTL: '1', SHELL: '/bin/zsh', PATH: `${path.join(e.root, 'fake')}:/usr/bin:/bin:/usr/sbin:/sbin` };
  return { args: [root, `--user-data-dir=${path.join(e.root, 'userdata')}`], env: env as Record<string, string> };
}

/** Starts the app in a fresh home (`config` is merged into the seeded config.json) and waits for its terminal. */
async function launch(config: Record<string, unknown> = {}): Promise<Run> {
  const e = makeEnv();
  envs.push(e);
  fakeClaude(path.join(e.root, 'fake'), { loggedIn: true, interactive: 'stub' });
  fs.mkdirSync(e.home, { recursive: true });
  const seeded = { onboarded: true, hotkey: '', tips: { enabled: false }, tour: { done: true }, ...config, window: { hintShown: true, ...(config.window as object) } };
  fs.writeFileSync(path.join(e.home, 'config.json'), JSON.stringify(seeded));
  const { args, env } = appArgs(e);
  const app = await _electron.launch({ executablePath: electronPath!, args, env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.term .xterm', { timeout: 40_000 });
  const client = new RpcClient(e.paths.socket);
  await client.connect(5_000);
  const daemonPid = (await client.call<{ pid: number }>('hello', {})).pid;
  const run: Run = { e, app, page, mainPid: app.process().pid!, daemonPid, client };
  live.push(run);
  return run;
}

/** The pid of the shell in the first terminal. */
async function shellPid(r: Run): Promise<number> {
  let pid = 0;
  await waitUntil(async () => !!(pid = ((await r.client.call<{ pid?: number }[]>('pane.list', {}))[0]?.pid ?? 0)), 15_000, 'the shell');
  return pid;
}

/** Types `sleep 300` into the first terminal through the page (as a keypress would) and waits until the shell reports it running. */
async function runSleep(r: Run): Promise<void> {
  await waitUntil(async () => (await r.client.call<{ alive?: boolean }[]>('pane.list', {}))[0]?.alive === true, 15_000, 'the shell to start');
  await sleep(800); // (the prompt's marks: the line below is a command, not typed ahead of the prompt)
  await r.page.evaluate(() => (window as any).jaffer.call('pty.write', { data: 'sleep 300\r' }));
  await waitUntil(async () => !!(await r.client.call<{ busy?: string | null }[]>('pane.list', {}))[0]?.busy, 15_000, 'sleep to run');
  await sleep(300); // (main hears pty.start in the same event stream)
}

/** From now on every native dialog of the app is answered with `response` (its default button when null) and recorded. */
async function answerDialogs(r: Run, response: number | null): Promise<void> {
  await r.app.evaluate(({ dialog }, response) => {
    const g = globalThis as any;
    g.__asked ??= [];
    g.__answer = response;
    dialog.showMessageBox = (async (...a: any[]) => {
      const o = a.length > 1 ? a[1] : a[0];
      g.__asked.push({ message: o.message, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId });
      return { response: g.__answer ?? o.defaultId ?? 0, checkboxChecked: false };
    }) as any;
  }, response);
}

const asked = (r: Run) => r.app.evaluate(() => ((globalThis as any).__asked ?? []) as { message: string; buttons: string[]; defaultId: number; cancelId: number }[]);

/** Clicks the application menu item labelled `label` (as a click or its accelerator through the real menu would). */
const clickMenu = (r: Run, label: string) =>
  r.app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === label) return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()!.items);
    if (!item) throw new Error(`no menu item ${label}`);
    (item.click as () => void)();
  }, label);

/** Resolves once the app's process has ended. */
const appEnded = (r: Run) => waitUntil(() => !alive(r.mainPid), 20_000, 'the app to end');

/**
 * Playwright's CDP session asserts on the replies a crashed page still gets ("Target crashed"), outside any call of ours. While the crash
 * test runs (and until its app is closed), only that error is dropped; anything else still reaches vitest.
 */
let restoreErrors: (() => void) | null = null;
function ignoreTargetCrashed(): void {
  type Listener = (...a: unknown[]) => void;
  const proc = process as unknown as { listeners(ev: string): Listener[]; removeAllListeners(ev: string): void; on(ev: string, l: Listener): void };
  const saved = ['unhandledRejection', 'uncaughtException'].map((ev) => [ev, proc.listeners(ev)] as const);
  for (const [ev, ls] of saved) {
    proc.removeAllListeners(ev);
    proc.on(ev, (err, ...rest) => {
      if (/Target crashed/.test(String((err as Error)?.message ?? err))) return;
      for (const l of ls) l(err, ...rest);
    });
  }
  restoreErrors = () => {
    for (const [ev, ls] of saved) {
      proc.removeAllListeners(ev);
      for (const l of ls) proc.on(ev, l);
    }
  };
}

afterEach(async () => {
  for (const r of live.splice(0)) {
    r.client.close();
    if (alive(r.mainPid)) await r.app.close().catch(() => undefined);
    for (const pid of [r.mainPid, r.daemonPid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
  if (restoreErrors) await sleep(500);
  restoreErrors?.();
  restoreErrors = null;
});
afterAll(() => {
  for (const e of envs) e.cleanup();
});

describe.skipIf(!runs)('the main process, through the real Electron', () => {
  it('starts its terminal host as its own child, and a split from the menu adds a terminal', async () => {
    const r = await launch();
    expect(ppid(r.daemonPid)).toBe(r.mainPid);
    expect(ppid(await shellPid(r))).not.toBe(r.mainPid); // (the shell is the daemon's, not the app's)
    await clickMenu(r, 'Split Terminal');
    await r.page.waitForFunction(() => document.querySelectorAll('.panes > .pane').length === 2, undefined, { timeout: 15_000 });
  }, 90_000);

  it('the red ✕ hides the window and the terminal runs on (window.closeAction: menubar, the default)', async () => {
    const r = await launch();
    const shell = await shellPid(r);
    await r.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await waitUntil(() => r.app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]!.isVisible()), 10_000, 'the window to hide');
    expect(await r.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1); // hidden, not destroyed
    await sleep(500);
    expect(alive(r.mainPid) && alive(r.daemonPid) && alive(shell)).toBe(true);
  }, 90_000);

  it('Quit Jaffer (⌘Q) with a command running asks, Cancel is the default and keeps it running; Quit ends the app, its child and the shell', async () => {
    const r = await launch();
    const shell = await shellPid(r);
    await runSleep(r);
    await answerDialogs(r, null); // the default button
    await clickMenu(r, 'Quit Jaffer');
    await waitUntil(async () => (await asked(r)).length === 1, 10_000, 'the quit question');
    const [q] = await asked(r);
    expect(q!.buttons).toEqual(['Quit', 'Cancel']);
    expect(q!.defaultId).toBe(1);
    expect(q!.cancelId).toBe(1);
    await sleep(800);
    expect(alive(r.mainPid) && alive(r.daemonPid) && alive(shell)).toBe(true); // Cancel: nothing ended
    await answerDialogs(r, 0); // Quit
    void clickMenu(r, 'Quit Jaffer').catch(() => undefined); // (the app may be gone before the call returns)
    await appEnded(r);
    await waitUntil(() => !alive(r.daemonPid) && !alive(shell), 10_000, 'the child and the shell to end');
    expect(fs.existsSync(r.e.paths.socket)).toBe(false); // it stopped, it did not crash
    expect(JSON.parse(fs.readFileSync(path.join(r.e.home, 'window.json'), 'utf8'))).toHaveProperty('width'); // the bounds were saved
  }, 90_000);

  it('a quit the system starts (logout, Dock → Quit, AppleScript: app.quit) never asks, and ends the command with the app', async () => {
    const r = await launch();
    const shell = await shellPid(r);
    await runSleep(r);
    await answerDialogs(r, 1);
    void r.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await appEnded(r);
    await waitUntil(() => !alive(r.daemonPid) && !alive(shell), 10_000, 'the child and the shell to end');
  }, 90_000);

  it('a killed app (SIGKILL: a crash, Force Quit) leaves no terminal host and no shell behind', async () => {
    const r = await launch();
    const shell = await shellPid(r);
    process.kill(r.mainPid, 'SIGKILL');
    await waitUntil(() => !alive(r.daemonPid) && !alive(shell), 15_000, 'the child and the shell to end');
  }, 90_000);

  it('a crashed page is reloaded with the terminal still there; the fourth crash in a minute asks, Reload being the default', async () => {
    const r = await launch();
    const shell = await shellPid(r);
    await answerDialogs(r, null);
    ignoreTargetCrashed();
    const crash = () => r.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
    const rendered = () => r.app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      return wc.isCrashed() || wc.isLoading() ? false : wc.executeJavaScript('!!document.querySelector(".term .xterm")').catch(() => false);
    });
    for (let i = 0; i < 3; i++) {
      await crash();
      await sleep(300);
      await waitUntil(rendered, 30_000, `the page to come back (crash ${i + 1})`);
    }
    expect(await asked(r)).toEqual([]);
    await crash();
    await waitUntil(async () => (await asked(r)).length === 1, 15_000, 'the crash question');
    const [q] = await asked(r);
    expect(q!.message).toBe('The window stopped responding.');
    expect(q!.buttons).toEqual(['Reload', 'Quit']);
    expect(q!.defaultId).toBe(0);
    await waitUntil(rendered, 30_000, 'the page to come back after Reload');
    expect((await r.client.call<{ pid: number }>('hello', {})).pid).toBe(r.daemonPid); // the terminal host was never touched
    expect(alive(shell)).toBe(true);
  }, 120_000);

  it('the page may write the clipboard but never read it, and has no other web permission', async () => {
    const r = await launch();
    const states = await r.page.evaluate(async () => {
      const out: Record<string, string> = {};
      for (const name of ['clipboard-read', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'notifications'])
        out[name] = await navigator.permissions.query({ name: name as PermissionName }).then((s) => s.state, (e) => `error: ${e}`);
      return out;
    });
    expect(states).toEqual({ 'clipboard-read': 'denied', 'clipboard-write': 'granted', camera: 'denied', microphone: 'denied', geolocation: 'denied', notifications: 'denied' });
  }, 90_000);

  it('only the first instance runs: a second one with the same data folder exits at once and starts no terminal', async () => {
    const r = await launch();
    const { args, env } = appArgs(r.e);
    const second = spawn(electronPath!, args, { env, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.once('exit', (c) => resolve(c)));
    expect(code).toBe(0);
    expect((await r.client.call<{ pid: number }>('hello', {})).pid).toBe(r.daemonPid);
  }, 90_000);

  it('window.menuBarOnly hides the Dock icon (only while the menu bar item exists)', async () => {
    const r = await launch({ window: { menuBarOnly: true } });
    await waitUntil(() => r.app.evaluate(({ app }) => !app.dock!.isVisible()), 10_000, 'the Dock icon to go');
  }, 90_000);
});
