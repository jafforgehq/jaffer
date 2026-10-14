import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { autoUpdater } from 'electron-updater';
import { makePaths } from '../shared/paths';
import { readJson, sleep, writeJson } from '../shared/util';
import { QUIT_WAIT_MS, startOwnedDaemon, tryConnect, waitForSocketGone, type ChildExit, type Launcher, type OwnedDaemon } from '../core/daemon-client';
import { commandNotification, needsYouNotification, shouldBounce } from '../shared/notify-policy';
import { isAppUrl, isWebUrl } from '../shared/window-policy';
import { FinishedNotifier } from '../shared/finished-notifier';
import type { ClaudeSession } from '../core/claude/watcher';
import type { RpcClient } from '../core/rpc';
import { VERSION } from '../core/version';
import { bundleProblem, isAllowedFeedUrl, manualResult, RELEASES_URL, signerKind, type UpdateState } from '../shared/update-policy';
import { childExitAction, childExitText, LEGACY_DIALOG, LEGACY_NOT_ENDED, legacyDaemonAction, QUIT_BUTTONS, QUIT_CANCEL_ID, QUIT_DEFAULT_ID, quitNeedsConfirm, shouldAskOnQuit, type QuitAsk } from '../shared/quit-policy';
import { isClaudeCommand } from '../shared/process-badge';
import { UpdateController, type UpdaterLike } from './updates';
import { updaterLog } from './updater-log';
import { prepareHome } from './prepare-home';
import { resetJaffer } from '../core/reset';
import { SAVE_TEXT_MAX, safeFileName } from '../shared/save-text';
import { editorUrl } from '../shared/editor-url';

/**
 * Electron shell. It owns the window and the macOS-native bits (menu, dock, notifications, global hotkey), and it starts the terminal
 * host (`jafferd`, which runs the shell) as its own child and relays between the renderer and it. The child lives as long as the app:
 * quitting Jaffer ends the shell and anything running in it (⌘Q asks first when something runs), and if the app crashes or is killed the
 * child sees its pipe end and stops too.
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
/** How long the start waits for an older Jaffer's session to let go of the socket once it was asked to end. */
const LEGACY_END_MS = 10_000;
/** Before asking about such a session, how long the start lets one that is already on its way out (an update just ended it) go by itself. */
const LEGACY_GRACE_MS = 3_000;
/** `prepareHome` gets this long at most: the terminal starts all the same. */
const PREPARE_HOME_MS = 30_000;

let win: BrowserWindow | null = null;
/** The app's own terminal host (its child), and the connection to it. */
let owned: OwnedDaemon | null = null;
let client: RpcClient | null = null;
/** The app is on its way out (quit, an update, Reset): the window closes instead of hiding, and the end of the child is expected. */
let quitting = false;
/** ⌘Q has nothing (more) to ask: the person said Quit, nothing ran, or the session had already ended. */
let quitConfirmed = false;
/** Set by the menu's Quit Jaffer (⌘Q) for the quit it starts: only that quit may ask. A quit the system starts never does. */
let askOnQuit = false;
let askingToQuit = false;
/** The child was ended for the quit (or did not end in time and was killed): the quit goes on. */
let childStopped = false;
let restarting = false;
/** The start has made the window (from then on the window is shown again or, if it was destroyed, made anew). */
let windowMade = false;
let hotkey = '';
const windowFile = path.join(paths.home, 'window.json');

app.setName('Jaffer');
/**
 * Only the first instance runs. Another one (Jaffer opened from the disk image while the installed copy runs, `open -n`, the binary run by
 * hand) hands over to it and exits at once: nothing of the start below ever runs in it (it would find the first instance's own terminal
 * answering on the socket and offer to end it). `app.exit`, not `app.quit`: no quit sequence, no event of this file.
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);
// (in the first instance: brings its window forward, once the start has made it; before that, during the start's own dialog or the
// first start's clean-up, there is nothing to show yet, and a window made then would be a second one)
else app.on('second-instance', () => windowMade && showWindow());

// ---------------------------------------------------------------- the terminal (the app's child)

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/** The command the shell runs now (from the daemon's events and `session.info`), for the question at ⌘Q. */
let runningCommand: string | null = null;

function wireClient(c: RpcClient, o: OwnedDaemon): void {
  c.on('*', ({ event, data }: { event: string; data: unknown }) => {
    sendToRenderer('jaffer:event', event, data);
    if (event === 'pty.notify') maybeNotify(data as { title: string; body: string });
    if (event === 'pty.bell') maybeBounce();
    if (event === 'pty.start') runningCommand = (data as { cmd?: string }).cmd || 'command';
    if (event === 'pty.command') {
      runningCommand = null;
      maybeNotifyCommand(data as { cmd: string; exit: number | null; durMs: number });
    }
    if (event === 'pty.exit' || event === 'session.lifecycle') runningCommand = null; // (a fresh shell runs nothing)
    if (event === 'claude.state') onClaudeState((data as { sessions: ClaudeSession[] }).sessions);
    if (event === 'config.changed') {
      appCfg = data as typeof appCfg;
      syncSystemStats();
    }
  });
  void c
    .call('config.get', {})
    .then((x) => {
      appCfg = x as typeof appCfg;
      syncSystemStats();
    })
    .catch(() => undefined);
  void c.call('session.info', {}).then((i: { busy?: string | null }) => (runningCommand = i?.busy ?? null)).catch(() => undefined);
  c.onClose.on(() => void onConnectionLost(o));
}

/** Start the app's own terminal host and connect to it. */
async function startTerminal(): Promise<void> {
  const o = await startOwnedDaemon(paths, launcher);
  owned = o;
  client = o.client;
  runningCommand = null;
  prevClaude = []; // a fresh terminal has no Claude yet: nothing of the old one's may count (the quit question, "needs you")
  wireClient(o.client, o);
  void o.exited.then((how) => onChildExit(o, how));
  await syncHotkey();
}

/** A fresh terminal (after a crash, or an update that did not install): the window starts over with it. */
async function restartTerminal(): Promise<void> {
  if (restarting || quitting) return;
  restarting = true;
  try {
    await startTerminal();
    sendToRenderer('jaffer:event', 'daemon.up', {});
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', message: 'Jaffer could not start its terminal', detail: `${e instanceof Error ? e.message : e}\n\nLog: ${paths.logFile}` });
    quitConfirmed = true;
    app.quit();
  } finally {
    restarting = false;
  }
}

/** The child ended: expected (the app ended it), a session a client ended (the app quits with it), or a crash (a fresh one, or Quit). */
async function onChildExit(o: OwnedDaemon, how: ChildExit): Promise<void> {
  if (owned !== o) return;
  runningCommand = null;
  const action = childExitAction({ ...how, quitting });
  if (action === 'ignore') return;
  if (action === 'quit') {
    // `jaffer reset`, `jaffer daemon stop`: the session was ended on purpose, and there is nothing left to ask about
    quitConfirmed = true;
    app.quit();
    return;
  }
  sendToRenderer('jaffer:event', 'daemon.down', {});
  const t = childExitText({ ...how, log: paths.logFile });
  const opts = { type: 'error' as const, message: t.message, detail: t.detail, buttons: [...t.buttons], defaultId: 0, cancelId: 1 };
  const r = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (quitting || owned !== o) return; // (quit meanwhile)
  if (r.response === 0) await restartTerminal();
  else {
    quitConfirmed = true;
    app.quit();
  }
}

/**
 * The connection closed. When the child ended, that is handled where its end is seen (`onChildExit`). When it still runs, the app connects
 * to it again (the window attaches anew); a child that runs but cannot be reached is killed, and the person is offered a fresh one.
 */
async function onConnectionLost(o: OwnedDaemon): Promise<void> {
  if (quitting || owned !== o || o.ended) return;
  const ended = await Promise.race([o.exited.then(() => true), sleep(1_000).then(() => false)]);
  if (ended || quitting || owned !== o) return;
  const c = await o.reconnect(5_000);
  if (quitting || owned !== o) return;
  if (c) {
    client = c;
    wireClient(c, o);
    sendToRenderer('jaffer:event', 'daemon.up', {});
    return;
  }
  o.kill();
}

/**
 * An older Jaffer kept its session running in the background, and it may still hold the socket (a new version installed over a running
 * one). The person is asked once (the default button is Quit, and Esc quits); then it is asked to end (`app.shutdown`, which every older version knows)
 * and the start waits for the socket to go. False: the person chose Quit, it did not end, or this is not the first instance.
 */
async function endOlderSession(): Promise<boolean> {
  if (!gotLock) return false; // (never reached in a second instance; and never its call to make)
  // a session already on its way out (an update from an older version ended it a moment ago) is let go by itself first: no question
  if (await waitForSocketGone(paths, LEGACY_GRACE_MS)) return true;
  const c = await tryConnect(paths);
  const hello = c ? await c.call<{ pid?: unknown }>('hello', { client: 'app', protocol: 1 }, 3_000).catch(() => null) : null;
  const action = legacyDaemonAction({ answers: !!c, pid: typeof hello?.pid === 'number' ? hello.pid : null, ownPid: owned?.pid ?? null, firstInstance: gotLock });
  if (action === 'leave') {
    c?.close();
    return false;
  }
  if (action !== 'ask') {
    c?.close();
    return true;
  }
  const r = await dialog.showMessageBox({ type: 'warning', message: LEGACY_DIALOG.message, detail: LEGACY_DIALOG.detail, buttons: [...LEGACY_DIALOG.buttons], defaultId: LEGACY_DIALOG.defaultId, cancelId: LEGACY_DIALOG.cancelId });
  if (r.response !== 0) {
    c?.close();
    return false;
  }
  await c?.call('app.shutdown', {}, 5_000).catch(() => undefined);
  c?.close();
  if (await waitForSocketGone(paths, LEGACY_END_MS)) return true;
  await dialog.showMessageBox({ type: 'error', message: LEGACY_NOT_ENDED.message, detail: LEGACY_NOT_ENDED.detail });
  return false;
}

/** `prepareHome`, never in the terminal's way: a failure is let go, and it gets PREPARE_HOME_MS at most. */
async function prepareHomeBounded(): Promise<void> {
  await Promise.race([prepareHome(paths).catch(() => undefined), sleep(PREPARE_HOME_MS)]);
}

// ---------------------------------------------------------------- notifications & dock

let lastTerminalNotifyAt = 0;
let prevClaude: ClaudeSession[] = [];
/** The settings the main process acts on itself (kept current from the daemon's config.changed). */
let appCfg: { notifications?: { claudeFinished?: boolean }; claude?: { showCost?: boolean }; terminal?: { editorUrl?: string }; appearance?: { systemStats?: boolean } } = {};

// ---------------------------------------------------------------- system stats (Settings → Appearance → System stats, off by default)

/** All cores' busy and total time so far: CPU use is the busy share of the time between two samples. */
function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times: t } of os.cpus()) {
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}
let statsTimer: NodeJS.Timeout | null = null;
let lastCpu = cpuTimes();
/** Sends CPU and memory in use every 5 s, only while the setting is on and the window exists. */
function syncSystemStats(): void {
  const on = appCfg.appearance?.systemStats === true && !!win && !win.isDestroyed();
  if (on && !statsTimer) {
    lastCpu = cpuTimes();
    statsTimer = setInterval(() => {
      if (!win || win.isDestroyed() || appCfg.appearance?.systemStats !== true) return syncSystemStats();
      const now = cpuTimes();
      const total = now.total - lastCpu.total;
      const cpu = total > 0 ? Math.min(1, Math.max(0, (now.busy - lastCpu.busy) / total)) : 0;
      lastCpu = now;
      sendToRenderer('jaffer:system-stats', { cpu, mem: Math.min(1, Math.max(0, 1 - os.freemem() / os.totalmem())) });
    }, 5000);
  } else if (!on && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

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

let lastBounceAt = 0;
/** A bell while the window is not in front: one gentle bounce of the Dock icon (at most one in five seconds; the terminal's flash stays). */
function maybeBounce(): void {
  if (win?.isFocused() || !shouldBounce(Date.now(), lastBounceAt)) return;
  lastBounceAt = Date.now();
  app.dock?.bounce('informational');
}

/** Claude Code works, or waits for the person (from its hooks). */
function claudeBusy(): boolean {
  return prevClaude.some((s) => s.state === 'working' || s.state === 'needs-you');
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

/** The installer failed or never restarted us after the session was ended: keep running, with a fresh terminal, and say so. */
function recoverFromFailedInstall(why: string): void {
  if (!installing) return;
  installing = false;
  quitting = false;
  quitConfirmed = false;
  childStopped = false;
  clearTimeout(installWatchdog);
  updates?.start();
  void dialog.showMessageBox({ type: 'error', message: 'The update could not be installed', detail: `${why.slice(0, 300)}\n\nJaffer is still running, with a fresh terminal. You can download the latest version from GitHub.`, buttons: ['Open releases page', 'OK'], defaultId: 1 }).then((r) => {
    if (r.response === 0) void shell.openExternal(RELEASES_URL);
  });
  void restartTerminal();
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
    claudeBusy,
    prepareInstall: async () => {
      installing = true;
      quitting = true;
      quitConfirmed = true; // the prompt already said that updating ends the terminal session
      updates?.stop(); // a background tick must not be mistaken for an install failure
      installWatchdog = setTimeout(() => recoverFromFailedInstall('Jaffer did not restart in time.'), 60_000);
      installWatchdog.unref();
      await owned?.stop(QUIT_WAIT_MS); // the shell and anything in it end before the app is replaced
      childStopped = true;
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
  if (win && !win.isDestroyed()) return; // one window, ever
  windowMade = true;
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
  win.on('closed', syncSystemStats);
  syncSystemStats();
  const save = () => {
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) writeJson(windowFile, win.getBounds());
  };
  win.on('resize', debounce(save, 400));
  win.on('move', debounce(save, 400));
  win.on('focus', () => sendToRenderer('jaffer:focus', true));
  win.on('blur', () => sendToRenderer('jaffer:focus', false));
  // Closing the window (⌘W) hides it: the terminal runs on while the app does, the hotkey brings it back, and ⌘Q is the way out.
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
        // ⌘Q ends the terminal and asks first when something runs (before-quit). Not `role: 'quit'`: only this item marks its quit as
        // one that may ask; a quit the system starts (logout, restart, shut down, the Dock's Quit) must never wait on a question.
        {
          label: 'Quit Jaffer',
          accelerator: 'Cmd+Q',
          click: () => {
            askOnQuit = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        { label: 'Hide Window', accelerator: 'Cmd+W', click: act('hide-window') },
        { type: 'separator' },
        { label: 'Clear Screen', accelerator: 'Cmd+K', click: act('clear') },
        { label: 'Find…', accelerator: 'Cmd+F', click: act('find') },
        { label: 'Find Next', accelerator: 'Cmd+G', click: act('find-next') },
        { label: 'Find Previous', accelerator: 'Shift+Cmd+G', click: act('find-prev') },
        { label: 'Copy as Markdown', accelerator: 'Alt+Cmd+C', click: act('copy-markdown') },
        { type: 'separator' },
        { label: 'Previous Prompt', accelerator: 'Cmd+Up', click: act('prompt-prev') },
        { label: 'Next Prompt', accelerator: 'Cmd+Down', click: act('prompt-next') },
        { label: 'Recent Commands…', accelerator: 'Cmd+R', click: act('recent-commands') },
        { label: 'Pin Selection', accelerator: 'Shift+Cmd+L', click: act('pin-selection') },
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
        { label: 'Show Log', click: () => void shell.openPath(paths.logFile) },
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
  if (!client || !client.connected) throw new Error('The terminal is not running.');
  const long = method.startsWith('setup.');
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
    detail: `This ends your terminal session and removes Jaffer's settings and hooks from this Mac. Claude Code itself, its login and your own Claude settings are not touched.\n\n“Reset and keep a backup” moves ${paths.home.replace(os.homedir(), '~')} aside (as ${paths.home.replace(os.homedir(), '~')}.backup-…) so you can get it back; “Reset and delete everything” does not.`,
    buttons: ['Cancel', 'Reset and keep a backup', 'Reset and delete everything'],
    defaultId: 0,
    cancelId: 0,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask);
  if (r.response === 0) return { cancelled: true };
  quitting = true; // from here the app is on its way out: the end of its terminal is expected
  quitConfirmed = true;
  updates?.stop();
  await client?.call('setup.claude.remove', {}).catch(() => undefined); // the daemon finds `claude` the way the terminal does
  try {
    // resetJaffer keeps the order: the login agent of an older Jaffer away, the session ended, then the rest
    await resetJaffer({
      home: paths.home,
      backup: r.response === 1,
      appData: false,
      endSession: async () => {
        await owned?.stop(QUIT_WAIT_MS);
        childStopped = true;
      },
    });
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
// "Save output…" of a command block: written only where the person picks in the save dialog, and not kept anywhere else
ipcMain.handle('jaffer:save-text', async (e, text: unknown, name: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (typeof text !== 'string') throw new Error('Nothing to save.');
  if (Buffer.byteLength(text) > SAVE_TEXT_MAX) throw new Error('That output is more than 32 MB: too much to save.');
  const ask = { defaultPath: path.join(app.getPath('downloads'), safeFileName(name)) };
  const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, ask) : await dialog.showSaveDialog(ask);
  if (r.canceled || !r.filePath) return { saved: false };
  await fs.promises.writeFile(r.filePath, text, { mode: 0o600 }); // (the mode applies to a new file; a file the person chose to replace keeps its own)
  return { saved: true };
});

/** A path the page names, as an absolute path that exists (a printed path is untrusted: it is only ever revealed, or handed to an editor). */
function existingPath(p: unknown): string | null {
  return typeof p === 'string' && p.length <= 4096 && path.isAbsolute(p) && fs.existsSync(p) ? p : null;
}
// ⌘-click on a printed path: the editor link from Settings (editor schemes only), else Finder. Never `shell.openPath`: a printed path to a script must not run.
ipcMain.handle('jaffer:open-path', async (e, p: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const { path: file, line, col } = (p ?? {}) as { path?: unknown; line?: unknown; col?: unknown };
  const abs = existingPath(file);
  if (!abs) return { opened: false };
  const url = editorUrl(appCfg.terminal?.editorUrl ?? '', abs, typeof line === 'number' ? line : undefined, typeof col === 'number' ? col : undefined);
  if (!url) {
    shell.showItemInFolder(abs);
    return { opened: true };
  }
  return shell.openExternal(url).then(
    () => ({ opened: true }),
    () => ({ opened: false, editorFailed: true }), // no app for that scheme
  );
});
// Shows a file the window names in Finder: selects it there, never opens or runs it.
ipcMain.handle('jaffer:reveal-path', (e, p: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const abs = existingPath(p);
  if (abs) shell.showItemInFolder(abs);
  return { revealed: !!abs };
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  if (!gotLock) return; // a second instance is on its way out (app.exit above): no menu, no start, no window, no smoke test
  buildMenu();
  // The start, in this order: an older Jaffer's background session ended (the person is asked first), Jaffer's home prepared, then the
  // app's own terminal started and connected.
  if (!(await endOlderSession())) {
    app.quit();
    return;
  }
  await prepareHomeBounded();
  try {
    await startTerminal();
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', message: 'Jaffer could not start its terminal', detail: `${e instanceof Error ? e.message : e}\n\nLog: ${paths.logFile}` });
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
    const hello = await js<{ version: string; pid: number }>('window.jaffer.call("hello", {})');
    if (hello.pid !== owned?.pid) return fail(`the terminal (pid ${hello.pid}) is not the app's own child (${owned?.pid})`);
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
    await owned?.stop(QUIT_WAIT_MS);
    app.exit(0);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

// Every quit ends the terminal. Only ⌘Q (the menu's Quit Jaffer) asks first, when Claude Code or a command would stop
// (`shouldAskOnQuit`). A quit the system starts (logout, restart, shut down, AppleScript, the Dock's Quit) never asks: macOS would take
// the question as the app refusing and cancel the logout. It ends the terminal through will-quit like any other quit.
app.on('before-quit', (e) => {
  const requested = askOnQuit;
  askOnQuit = false; // (it belongs to this one quit: a later one, from the system, must not inherit it)
  if (!quitConfirmed) {
    const o = owned;
    const childEnded = !o || o.ended;
    const ask = childEnded ? null : quitNeedsConfirm({ claudeWorking: claudeBusy() || (runningCommand !== null && isClaudeCommand(runningCommand)), commandRunning: runningCommand !== null });
    if (ask && shouldAskOnQuit({ askRequested: requested, confirmed: quitConfirmed, installing, childEnded, needsConfirm: !!ask })) {
      e.preventDefault();
      void confirmQuit(ask);
      return;
    }
    quitConfirmed = true;
  }
  quitting = true;
});

async function confirmQuit(ask: QuitAsk): Promise<void> {
  if (askingToQuit) return;
  askingToQuit = true;
  try {
    showWindow(); // in front, as a sheet on the window: a hidden window (⌘W) would leave the question behind other apps
    const opts = { type: 'warning' as const, message: ask.message, detail: ask.detail, buttons: [...QUIT_BUTTONS], defaultId: QUIT_DEFAULT_ID, cancelId: QUIT_CANCEL_ID };
    const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) return; // Cancel: nothing ends (and the next quit asks again only if it is a ⌘Q)
    quitConfirmed = true;
    app.quit();
  } finally {
    askingToQuit = false;
  }
}

// The app's last step: its child is told to end (its pipe ends), given QUIT_WAIT_MS, then killed; then the app exits.
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  const o = owned;
  if (childStopped || !o || o.ended) return;
  e.preventDefault();
  void o.stop(QUIT_WAIT_MS).finally(() => {
    childStopped = true;
    app.quit();
  });
});
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


