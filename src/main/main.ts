import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, nativeTheme, screen, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { readJson, sleep, writeJson } from '../shared/util';
import { ensureDaemon, tryConnect, type Launcher } from '../core/daemon-client';
import { needsYouNotification } from '../shared/notify-policy';
import type { ClaudeSession } from '../core/claude/watcher';
import type { RpcClient } from '../core/rpc';
import { VERSION } from '../core/version';

/**
 * Electron shell. It owns the window and the macOS-native bits (menu, dock, notifications,
 * global hotkey) and relays between the renderer and the session daemon. The daemon — not this
 * process — owns the shell, so quitting the app never ends your session.
 */

const paths = makePaths();
const distRoot = path.join(__dirname, '..');
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
    if (event === 'pty.command') maybeNotifyCommand(data as { cmd: string; exit: number | null; durMs: number; by: string });
    if (event === 'claude.state') onClaudeState((data as { sessions: ClaudeSession[] }).sessions);
    if (event === 'agent.event') onAgentEvent(data as { type: string; stopReason?: string; error?: string; name?: string; summary?: string });
  });
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

function maybeNotify(n: { title: string; body: string }): void {
  if (win?.isFocused()) return;
  lastTerminalNotifyAt = Date.now();
  notify(n.title || 'Terminal', n.body);
}

/** Claude, in the terminal, is waiting for the user and they are looking elsewhere. */
function onClaudeState(sessions: ClaudeSession[]): void {
  const n = needsYouNotification(prevClaude, sessions, { windowFocused: !!win?.isFocused(), lastTerminalNotifyAt, now: Date.now() });
  prevClaude = sessions;
  if (!n) return;
  app.dock?.bounce('critical');
  notify(n.title, n.body);
}

/** A long command finished while you were looking at something else. */
function maybeNotifyCommand(c: { cmd: string; exit: number | null; durMs: number; by: string }): void {
  if (c.by === 'agent' || c.durMs < 30_000 || win?.isFocused() || !c.cmd.trim()) return;
  const secs = Math.round(c.durMs / 1000);
  const took = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
  notify(c.exit === 0 ? 'Command finished' : `Command failed (exit ${c.exit})`, `${c.cmd.slice(0, 120)} — ${took}`);
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body: body.slice(0, 240) });
  note.on('click', () => showWindow());
  note.show();
}

function onAgentEvent(e: { type: string; stopReason?: string; error?: string; name?: string; summary?: string }): void {
  if (win?.isFocused()) return;
  if (e.type === 'turn_end') {
    app.dock?.bounce('informational');
    notify(e.error ? 'Jaffer hit a problem' : 'Jaffer finished', e.error ?? 'The agent finished its turn.');
  } else if (e.type === 'approval_request') {
    app.dock?.bounce('critical');
    notify('Jaffer needs approval', `${e.name}: ${e.summary ?? ''}`);
  }
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
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
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: act('toggle-rail') },
        { label: 'Toggle Agent', accelerator: 'Cmd+J', click: act('toggle-agent') },
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
  const url = e.senderFrame?.url ?? '';
  return url.startsWith('file://') && !!win && e.sender === win.webContents;
}

ipcMain.handle('jaffer:call', async (e, method: string, params: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (!client || !client.connected) throw new Error('The session daemon is not connected.');
  const long = method.startsWith('agent.compact') || method.startsWith('setup.') || method === 'memory.reflect' || method === 'memory.consolidate';
  const r = await client.call(method, params, long ? 120_000 : 30_000);
  if (method === 'config.patch') void syncHotkey();
  return r;
});
ipcMain.handle('jaffer:notify', (e, title: string, body: string) => {
  if (trusted(e)) notify(String(title), String(body));
});
ipcMain.handle('jaffer:open-external', (e, url: string) => {
  if (trusted(e) && /^https?:\/\//.test(url)) void shell.openExternal(url);
});
ipcMain.handle('jaffer:reveal', (e, p: string) => {
  if (trusted(e)) void shell.openPath(String(p));
});
ipcMain.handle('jaffer:app-info', (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  return { version: VERSION, platform: process.platform, dark: nativeTheme.shouldUseDarkColors, home: paths.home, packaged: app.isPackaged };
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

void fs;
