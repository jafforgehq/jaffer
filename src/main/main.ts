import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { autoUpdater } from 'electron-updater';
import { makePaths } from '../shared/paths';
import { readJson, sleep, writeJson } from '../shared/util';
import { ensureDaemon, tryConnect, type Launcher } from '../core/daemon-client';
import { commandNotification, needsYouNotification } from '../shared/notify-policy';
import { isAppUrl, isWebUrl } from '../shared/window-policy';
import { FinishedNotifier } from '../shared/finished-notifier';
import type { ClaudeSession } from '../core/claude/watcher';
import type { RpcClient } from '../core/rpc';
import { VERSION } from '../core/version';
import { bundleProblem, isAllowedFeedUrl, manualResult, RELEASES_URL, signerKind, type UpdateState } from '../shared/update-policy';
import { UpdateController, type UpdaterLike } from './updates';
import { updaterLog } from './updater-log';
import { resetJaffer } from '../core/reset';

/**
 * Electron shell. It owns the window and the macOS-native bits (menu, dock, notifications,
 * global hotkey) and relays between the renderer and the session daemon. The daemon — not this
 * process — owns the shell, so quitting the app never ends your session.
 */

const paths = makePaths();
const distRoot = path.join(__dirname, '..');
/** The one page the window may show. Anything else (a file dropped on it, a link) is not given the daemon bridge. */
const indexUrl = pathToFileURL(path.join(distRoot, 'renderer', 'index.html')).href;
const launcher: Launcher = {
  execPath: process.execPath,
  daemonScript: path.join(distRoot, 'daemon', 'jafferd.cjs'),
  cliScript: path.join(distRoot, 'cli', 'jaffer.cjs'),
  electron: true,
};

let win: BrowserWindow | null = null;
let client: RpcClient | null = null;
let quitting = false;
let reconnecting = false;
let hotkey = '';
const windowFile = path.join(paths.home, 'window.json');

app.setName('Jaffer');
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => showWindow());

// ---------------------------------------------------------------- daemon connection

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function wireClient(c: RpcClient): void {
  c.on('*', ({ event, data }: { event: string; data: unknown }) => {
    sendToRenderer('jaffer:event', event, data);
    if (event === 'pty.notify') maybeNotify(data as { title: string; body: string });
    if (event === 'pty.command') maybeNotifyCommand(data as { cmd: string; exit: number | null; durMs: number });
    if (event === 'claude.state') onClaudeState((data as { sessions: ClaudeSession[] }).sessions);
    // resuming Claude by itself stopped after a few crashes: said once, whether or not the window is open
    if (event === 'claude.autoresume' && (data as { state?: string } | null)?.state === 'gave-up') notify('Claude keeps stopping', 'Resume it from the button when you are ready.');
    if (event === 'config.changed') appCfg = data as typeof appCfg;
  });
  void c.call('config.get', {}).then((x) => (appCfg = x as typeof appCfg)).catch(() => undefined);
  c.onClose.on(() => void onDaemonDown());
}

async function connect(): Promise<void> {
  client = await ensureDaemon(paths, launcher);
  wireClient(client);
  const hello = await client.call('hello', { client: 'app', protocol: 1 });
  if (hello.version !== VERSION) await offerRestart(hello.version);
  await syncHotkey();
}

async function onDaemonDown(): Promise<void> {
  if (quitting || reconnecting) return;
  reconnecting = true;
  sendToRenderer('jaffer:event', 'daemon.down', {});
  for (let i = 0; i < 40 && !quitting; i++) {
    try {
      await connect();
      sendToRenderer('jaffer:event', 'daemon.up', {});
      break;
    } catch {
      await sleep(750);
    }
  }
  reconnecting = false;
}

async function offerRestart(oldVersion: string): Promise<void> {
  const r = await dialog.showMessageBox({
    type: 'info',
    message: 'Jaffer was updated',
    detail: `Your session is still running the previous version (${oldVersion}). Restart it to use ${VERSION}? Your shell restarts in the same folder; memory and the conversation are kept.`,
    buttons: ['Restart session', 'Later'],
    defaultId: 0,
  });
  if (r.response !== 0) return;
  await client?.call('app.shutdown', {}).catch(() => undefined);
  client?.close();
  for (let i = 0; i < 40 && (await tryConnect(paths, 300)); i++) await sleep(150);
  client = await ensureDaemon(paths, launcher);
  wireClient(client);
  sendToRenderer('jaffer:event', 'daemon.up', {});
}

// ---------------------------------------------------------------- notifications & dock

let lastTerminalNotifyAt = 0;
let prevClaude: ClaudeSession[] = [];
/** The settings the main process acts on itself (kept current from the daemon's config.changed). */
let appCfg: { notifications?: { claudeFinished?: boolean }; claude?: { showCost?: boolean } } = {};

/** "Claude finished", after a long turn, while you are looking elsewhere. */
const finished = new FinishedNotifier({
  enabled: () => appCfg.notifications?.claudeFinished !== false,
  showCost: () => appCfg.claude?.showCost !== false,
  windowFocused: () => !!win?.isFocused(),
  lastTerminalNotifyAt: () => lastTerminalNotifyAt,
  now: Date.now,
  notify: (n) => notify(n.title, n.body),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
});

function maybeNotify(n: { title: string; body: string }): void {
  if (win?.isFocused()) return;
  lastTerminalNotifyAt = Date.now();
  notify(n.title || 'Terminal', n.body);
}

/** Claude, in the terminal, is waiting for the user and they are looking elsewhere. */
function onClaudeState(sessions: ClaudeSession[]): void {
  finished.update(sessions);
  const n = needsYouNotification(prevClaude, sessions, { windowFocused: !!win?.isFocused(), lastTerminalNotifyAt, now: Date.now() });
  prevClaude = sessions;
  if (!n) return;
  app.dock?.bounce('critical');
  notify(n.title, n.body);
}

/** A long command finished while you were looking at something else. */
function maybeNotifyCommand(c: { cmd: string; exit: number | null; durMs: number }): void {
  const n = commandNotification(c, { windowFocused: !!win?.isFocused() });
  if (n) notify(n.title, n.body);
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body: body.slice(0, 240) });
  note.on('click', () => showWindow());
  note.show();
}

// ---------------------------------------------------------------- updates

let updates: UpdateController | null = null;
let installing = false;
let autoUpdates = true;
const updateLog = updaterLog(path.join(paths.home, 'updater.log'));
const noUpdater: UpdaterLike = { on: () => undefined, checkForUpdates: async () => null, quitAndInstall: () => undefined };
const idleUpdateState = (): UpdateState => ({ status: 'unavailable', current: VERSION, auto: autoUpdates });

/** The running bundle's signature: only a Developer ID signed app can be updated in place. */
function bundleSigner(): Promise<ReturnType<typeof signerKind>> {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dvv', bundle], { timeout: 10_000 }, (_err, stdout, stderr) => resolve(signerKind(`${stdout}\n${stderr}`)));
  });
}

/** The prompt must be seen: if Jaffer is in the background, nudge with a notification and ask once the window is in front. */
async function whenWindowFocused(version: string): Promise<void> {
  if (win && !win.isDestroyed() && win.isFocused()) return;
  notify(`Jaffer ${version} is ready`, 'Click to review the update. Nothing is installed until you say so.');
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (win && !win.isDestroyed() && win.isFocused()) {
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });
}

let installWatchdog: NodeJS.Timeout | undefined;

/** The installer failed or never restarted us after the session was ended: keep running, with a fresh session, and say so. */
function recoverFromFailedInstall(why: string): void {
  if (!installing) return;
  installing = false;
  quitting = false;
  clearTimeout(installWatchdog);
  updates?.start();
  void dialog.showMessageBox({ type: 'error', message: 'The update could not be installed', detail: `${why.slice(0, 300)}\n\nJaffer is still running, with a fresh session. You can download the latest version from GitHub.`, buttons: ['Open releases page', 'OK'], defaultId: 1 }).then((r) => {
    if (r.response === 0) void shell.openExternal(RELEASES_URL);
  });
  void onDaemonDown();
}

async function setupUpdates(): Promise<void> {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  let writable = true;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const signed = app.isPackaged && !process.env.JAFFER_SMOKE && (await bundleSigner()) === 'developer-id';
  const problem = signed ? bundleProblem(bundle, writable) : null; // an install that is bound to fail must not end the session first
  const eligible = signed && !problem;
  if (eligible) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false; // quitting must never replace the app behind a running session
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = { info: (m: unknown) => updateLog(String(m)), warn: (m: unknown) => updateLog(`warn ${m}`), error: (m: unknown) => updateLog(`error ${m}`), debug: () => undefined };
    const feed = process.env.JAFFER_UPDATE_URL;
    if (feed && isAllowedFeedUrl(feed)) autoUpdater.setFeedURL({ provider: 'generic', url: feed }); // for testing the flow against a local server
    autoUpdater.on('error', (e: Error) => recoverFromFailedInstall(e.message));
  }
  updates = new UpdateController({
    updater: eligible ? autoUpdater : noUpdater, // electron-updater is not even touched in builds that cannot update
    current: VERSION,
    enabled: eligible,
    unavailableReason: problem ?? undefined,
    auto: () => autoUpdates,
    ask: async (text, version, manual) => {
      if (manual) showWindow();
      else await whenWindowFocused(version);
      const t = text(); // built now, not when the update arrived: the Claude warning has to be current
      const parent = win && !win.isDestroyed() ? win : undefined;
      const opts = { type: 'info' as const, message: t.message, detail: t.detail, buttons: [...t.buttons], defaultId: t.defaultId, cancelId: t.cancelId };
      const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    },
    claudeBusy: () => prevClaude.some((s) => s.state === 'working' || s.state === 'needs-you'),
    prepareInstall: async () => {
      installing = true;
      quitting = true;
      updates?.stop(); // a background tick must not be mistaken for an install failure
      installWatchdog = setTimeout(() => recoverFromFailedInstall('Jaffer did not restart in time.'), 60_000);
      installWatchdog.unref();
      await client?.call('app.shutdown', {}).catch(() => undefined);
      client?.close();
    },
    log: updateLog,
    onState: (s) => sendToRenderer('jaffer:event', 'update.state', s),
  });
  await syncUpdates();
  sendToRenderer('jaffer:event', 'update.state', updates.state());
  updates.start();
}

async function syncUpdates(): Promise<void> {
  try {
    const c = await client?.call('config.get', {});
    autoUpdates = c?.updates?.auto !== false;
  } catch {
    /* keep the last value */
  }
}

/** Jaffer → Check for Updates…: always answers. The update prompt itself comes from the controller. */
async function manualUpdateCheck(): Promise<void> {
  const s = updates ? await updates.checkNow() : idleUpdateState();
  const r = manualResult(s);
  if (!r) return;
  const res = await dialog.showMessageBox({ type: 'info', message: r.message, detail: r.detail, buttons: r.releases ? ['Open releases page', 'OK'] : ['OK'], defaultId: r.releases ? 1 : 0 });
  if (r.releases && res.response === 0) void shell.openExternal(RELEASES_URL);
}

// ---------------------------------------------------------------- window

function loadBounds(): Electron.Rectangle | undefined {
  const b = readJson<Electron.Rectangle | null>(windowFile, null);
  if (!b || !b.width || !b.height) return undefined;
  const visible = screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
  return visible ? b : { width: b.width, height: b.height, x: undefined as unknown as number, y: undefined as unknown as number };
}

function createWindow(): void {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Jaffer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win?.show());
  const save = () => {
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) writeJson(windowFile, win.getBounds());
  };
  win.on('resize', debounce(save, 400));
  win.on('move', debounce(save, 400));
  win.on('focus', () => sendToRenderer('jaffer:focus', true));
  win.on('blur', () => sendToRenderer('jaffer:focus', false));
  // Closing the window hides it; the session lives on in the daemon and ⌘Q is the way out.
  win.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Only the app's own page. A file dropped on the window would otherwise navigate it to that file, which would then have the
  // preload and so the daemon bridge (and a shell to type into).
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url, indexUrl)) return;
    e.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
  });
  void win.loadFile(path.join(distRoot, 'renderer', 'index.html'));
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.dock?.show();
}

function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

async function syncHotkey(): Promise<void> {
  try {
    const cfg = await client?.call('config.get', {});
    const want: string = cfg?.hotkey ?? '';
    if (want === hotkey) return;
    if (hotkey) globalShortcut.unregister(hotkey);
    hotkey = '';
    if (want && globalShortcut.register(want, toggleWindow)) hotkey = want;
  } catch {
    /* hotkey is optional */
  }
}

// ---------------------------------------------------------------- menu

function buildMenu(): void {
  const act = (id: string) => () => sendToRenderer('jaffer:menu', id);
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Jaffer',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void manualUpdateCheck() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: act('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit and End Session',
          accelerator: 'Alt+Cmd+Q',
          click: async () => {
            const r = await dialog.showMessageBox({ type: 'warning', message: 'End your session?', detail: 'This closes your shell and anything running in it. Memory and the conversation are kept.', buttons: ['End Session', 'Cancel'], defaultId: 1, cancelId: 1 });
            if (r.response === 0) {
              quitting = true;
              await client?.call('app.shutdown', {}).catch(() => undefined);
              app.quit();
            }
          },
        },
        { role: 'quit', label: 'Quit Jaffer (session keeps running)' },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        { label: 'Hide Window (session keeps running)', accelerator: 'Cmd+W', click: act('hide-window') },
        { type: 'separator' },
        { label: 'Clear Screen', accelerator: 'Cmd+K', click: act('clear') },
        { label: 'Find…', accelerator: 'Cmd+F', click: act('find') },
        { type: 'separator' },
        { label: 'Run Claude Code', accelerator: 'Shift+Cmd+C', click: act('run-claude') },
        { label: 'Restart Shell', click: act('restart-shell') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'Cmd+P', click: act('palette') },
        { type: 'separator' },
        { label: 'Toggle Memory', accelerator: 'Shift+Cmd+M', click: act('toggle-memory') },
        { type: 'separator' },
        { label: 'Bigger', accelerator: 'Cmd+=', click: act('zoom-in') },
        { label: 'Smaller', accelerator: 'Cmd+-', click: act('zoom-out') },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: act('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Jaffer on GitHub', click: () => void shell.openExternal('https://github.com/jafforgehq/jaffer') },
        { label: 'Reveal Session Folder', click: () => void shell.openPath(paths.home) },
        { label: 'Show Daemon Log', click: () => void shell.openPath(paths.logFile) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- ipc

function trusted(e: Electron.IpcMainInvokeEvent): boolean {
  return isAppUrl(e.senderFrame?.url, indexUrl) && !!win && e.sender === win.webContents;
}

ipcMain.handle('jaffer:call', async (e, method: string, params: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (!client || !client.connected) throw new Error('The session daemon is not connected.');
  const long = method.startsWith('setup.') || method === 'memory.reflect' || method === 'memory.consolidate';
  const r = await client.call(method, params, long ? 120_000 : 30_000);
  if (method === 'config.patch') {
    void syncHotkey();
    void syncUpdates();
  }
  return r;
});
ipcMain.handle('jaffer:open-external', (e, url: string) => {
  if (trusted(e) && /^https?:\/\//.test(url)) void shell.openExternal(url);
});
ipcMain.handle('jaffer:reveal', (e) => {
  if (trusted(e)) void shell.openPath(paths.home); // Jaffer's own folder only, never a path the page names
});
ipcMain.handle('jaffer:app-info', (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  return { version: VERSION, platform: process.platform, dark: nativeTheme.shouldUseDarkColors, home: paths.home, packaged: app.isPackaged, openAtLogin: app.getLoginItemSettings().openAtLogin };
});
ipcMain.handle('jaffer:update-state', (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  return updates ? updates.state() : idleUpdateState();
});
ipcMain.handle('jaffer:update-check', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  return updates ? await updates.checkNow() : idleUpdateState();
});
ipcMain.handle('jaffer:reset', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const ask = {
    type: 'warning' as const,
    message: 'Reset Jaffer and start from scratch?',
    detail: `This ends your terminal session and removes Jaffer's memory, settings, hooks and memory tools from this Mac. Claude Code itself, its login and your own Claude settings are not touched.\n\n“Reset and keep a backup” moves ${paths.home.replace(os.homedir(), '~')} aside (as ${paths.home.replace(os.homedir(), '~')}.backup-…) so you can get it back; “Reset and delete everything” does not.`,
    buttons: ['Cancel', 'Reset and keep a backup', 'Reset and delete everything'],
    defaultId: 0,
    cancelId: 0,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask);
  if (r.response === 0) return { cancelled: true };
  quitting = true; // from here the app is on its way out and must not reconnect to the session it is ending
  updates?.stop();
  await client?.call('setup.claude.remove', {}).catch(() => undefined); // the daemon finds `claude` the way the terminal does
  await client?.call('app.shutdown', {}).catch(() => undefined);
  client?.close();
  for (let i = 0; i < 40 && (await tryConnect(paths, 300)); i++) await sleep(150);
  try {
    await resetJaffer({ home: paths.home, backup: r.response === 1, appData: false });
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    app.setLoginItemSettings({ openAtLogin: false });
  } catch (err) {
    quitting = false;
    await dialog.showMessageBox({ type: 'error', message: 'Reset did not finish', detail: String(err instanceof Error ? err.message : err).slice(0, 400) });
    app.relaunch();
    app.exit(0);
    return { cancelled: false };
  }
  app.relaunch();
  app.exit(0);
  return { cancelled: false };
});
ipcMain.handle('jaffer:set-login-item', (e, on: boolean) => {
  if (trusted(e)) app.setLoginItemSettings({ openAtLogin: !!on });
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  buildMenu();
  try {
    await connect();
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', message: 'Jaffer could not start its session daemon', detail: `${e instanceof Error ? e.message : e}\n\nLog: ${paths.logFile}` });
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', showWindow);
  void setupUpdates();
  if (process.env.JAFFER_SMOKE) void smokeTest();
});

/**
 * `JAFFER_SMOKE=1 Jaffer.app/Contents/MacOS/Jaffer` boots the real app, checks that the daemon, the shell,
 * the preload bridge and the renderer all work together, prints SMOKE OK/FAIL and exits. CI runs this on macOS.
 */
async function smokeTest(): Promise<void> {
  const fail = (why: string) => {
    process.stdout.write(`SMOKE FAIL: ${why}\n`);
    quitting = true;
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out after 60s'), 60_000);
  try {
    const w = win!;
    await new Promise<void>((resolve) => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', () => resolve()) : resolve()));
    const js = <T>(code: string) => w.webContents.executeJavaScript(code) as Promise<T>;
    const hasBridge = await js<boolean>('typeof window.jaffer === "object" && typeof window.jaffer.call === "function"');
    if (!hasBridge) return fail('preload bridge missing');
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && !(await js<boolean>('!!document.querySelector(".term .xterm")'))) await sleep(200);
    if (!(await js<boolean>('!!document.querySelector(".term .xterm")'))) return fail('terminal never rendered');
    const hello = await js<{ version: string }>('window.jaffer.call("hello", {})');
    const upd = await js<{ status: string; current: string }>('window.jaffer.updates.state()');
    if (upd.current !== hello.version) return fail(`update state is for ${upd.current}, the daemon is ${hello.version}`);
    await js('window.jaffer.call("config.patch", { onboarded: true })');
    // type into the real shell through the same path the UI uses and read the command back from the daemon
    await js('window.jaffer.call("session.attach", { cols: 100, rows: 30 })');
    await sleep(1500);
    await js('window.jaffer.call("pty.write", { data: "echo smoke-$((40+2))\\r" })');
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      await sleep(250);
      const snap = await js<{ data: string }>('window.jaffer.call("session.snapshot", {})');
      seen = snap.data.includes('smoke-42');
    }
    if (!seen) return fail('shell did not echo output');
    const shellOk = await js<boolean>('window.jaffer.call("pane.list", {}).then((p) => p.length > 0 && p[0].alive)');
    if (!shellOk) return fail('main pane is not alive');
    clearTimeout(timer);
    process.stdout.write(`SMOKE OK (daemon ${hello.version}, electron ${process.versions.electron}, ${process.platform}-${process.arch})\n`);
    quitting = true;
    await client?.call('app.shutdown', {}).catch(() => undefined);
    app.exit(0);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined;
  return ((...a: never[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}


