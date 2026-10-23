import { app, BrowserWindow, clipboard, dialog as electronDialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, nativeTheme, screen, session, shell, systemPreferences, Tray, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { autoUpdater } from 'electron-updater';
import { makePaths } from '../shared/paths';
import { readJson, sleep, writeJson } from '../shared/util';
import { QUIT_WAIT_MS, startOwnedDaemon, tryConnect, waitForSocketGone, type ChildExit, type Launcher, type OwnedDaemon } from '../core/daemon-client';
import { commandNotification, needsYouNotification, shouldBounce, terminalWhere } from '../shared/notify-policy';
import { isPaneId } from '../shared/session-id';
import { appearanceChanged, dropdownBounds, isAppUrl, keepsBounds, isWebUrl, MIN_WINDOW_HEIGHT, vibrancyFor } from '../shared/window-policy';
import { FinishedNotifier } from '../shared/finished-notifier';
import type { ClaudeSession } from '../core/claude/watcher';
import type { ApprovalView } from '../core/claude/approvals';
import type { RpcClient } from '../core/rpc';
import { VERSION } from '../core/version';
import { RELEASE_NOTES } from '../generated/release-notes';
import { effectiveSeen, unseenNotes } from '../shared/whats-new';
import { bundleProblem, manualResult, RELEASES_URL, signerKind, type UpdateState } from '../shared/update-policy';
import { CRASH_DIALOG, CRASH_RELOADS, crashAction } from '../shared/crash-policy';
import { childExitAction, childExitText, LEGACY_DIALOG, LEGACY_NOT_ENDED, legacyDaemonAction, QUIT_BUTTONS, QUIT_CANCEL_ID, QUIT_DEFAULT_ID, quitNeedsConfirm, quitState, shouldAskOnQuit, type QuitAsk } from '../shared/quit-policy';
import { UpdateController, type UpdaterLike } from './updates';
import { updaterLog } from './updater-log';
import { prepareHome } from './prepare-home';
import { resetJaffer } from '../core/reset';
import { SAVE_TEXT_MAX, safeFileName } from '../shared/save-text';
import { editorUrl } from '../shared/editor-url';
import { MENU_ITEMS } from '../shared/menu-spec';
import { NOT_ALLOWED, pageMayCall } from '../shared/page-methods';
import { FocusHold, type HoldKind } from '../shared/focus-hold';
import { digestDue, digestLine, digestText, type UsageWeeks } from '../shared/usage-week';
import { CLOSE_ASK, closeDecision, HIDE_HINT } from '../shared/close-action';
import { RecentCommands } from '../shared/recent-commands';
import { historyMenuItems, resumeCommand } from '../shared/history-label';
import { parseNames } from '../shared/history-names';
import { trashAsk, trashConversations } from './trash-conversations';
import { assertVoiceDir, downloadVoice, readVoiceFile, removeVoice, voiceStatus, VoiceDownloadError } from './voice-models';
import { VOICE_RUNTIME_WASM } from '../shared/voice-manifest';
import { pageMayUseMic } from '../shared/voice-permission';
import { BLOCKED_URL_FILTER, requestAllowed } from '../shared/request-policy';
import { VoiceEpoch } from '../shared/voice-epoch';
import { MAX_REMOVE, type Conversation } from '../core/claude/history';
import { TrayIconPlayer, trayMenuLines, trayState, trayTitle, type MenuBarTitle, type TrayFrame } from '../shared/tray-state';
import type { DayTotal } from '../shared/claude-cost';
import type { GitStatus } from '../core/session/git-status';
import { TRAY_ICONS } from '../generated/tray-icons';

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
/** How many of our dialogs are open: in drop-down mode a window that loses focus to one of them must not hide. */
let dialogsOpen = 0;
const counted = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  dialogsOpen++;
  try {
    return await f(...a);
  } finally {
    dialogsOpen--;
  }
};
const dialog = {
  showMessageBox: counted(electronDialog.showMessageBox.bind(electronDialog)) as typeof electronDialog.showMessageBox,
  showSaveDialog: counted(electronDialog.showSaveDialog.bind(electronDialog)) as typeof electronDialog.showSaveDialog,
};
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

/** The command each terminal's shell runs now (from the daemon's events and `pane.list`), for the question at ⌘Q: any terminal counts. */
const runningCommands = new Map<string, string>();
/** (1.5.0) Each terminal's folder (`pane.list`, `pty.cwd`, `session.lifecycle`), for naming the terminal in a notification. Memory only. */
const paneFolders = new Map<string, string>();
/** The name of the terminal a session lives in, for a notification: nothing with one terminal. */
const whereOf = (s: ClaudeSession): string => terminalWhere(s.pane, paneFolders, paneFolders.size);
/**
 * Brings the window back and asks the page to focus the terminal of `session`, but only if that session is still known and still in that
 * terminal when the click comes (a closed terminal's id can be used again by an unrelated one); otherwise it only shows the window.
 */
function showAndFocus(pane?: string, session?: string): void {
  showWindow();
  if (isPaneId(pane) && prevClaude.some((s) => s.id === session && s.pane === pane)) sendToRenderer('jaffer:event', 'app.focus-pane', { pane });
}
/** Reads `pane.list`. At connect (`first`) it also seeds the running commands; a re-read after `spawned` only sets the folders of the listed terminals and forgets the unlisted ones (an event that raced with the answer is not undone). */
function loadPaneFolders(c: RpcClient, first = false): void {
  void c
    .call('pane.list', {})
    .then((list: { id: string; cwd?: unknown; busy?: string | null }[]) => {
      const ids = new Set<string>();
      for (const p of list) {
        if (typeof p.id !== 'string') continue;
        ids.add(p.id);
        if (first && p.busy) runningCommands.set(p.id, p.busy);
        paneFolders.set(p.id, typeof p.cwd === 'string' ? p.cwd : '');
      }
      for (const id of [...paneFolders.keys()]) if (!ids.has(id)) paneFolders.delete(id);
    })
    .catch(() => undefined);
}

function wireClient(c: RpcClient, o: OwnedDaemon): void {
  c.on('*', ({ event, data }: { event: string; data: unknown }) => {
    sendToRenderer('jaffer:event', event, data);
    if (event === 'pty.notify') maybeNotify(data as { title: string; body: string });
    if (event === 'pty.bell') maybeBounce();
    const pane = (data as { pane?: unknown } | null)?.pane;
    const id = typeof pane === 'string' ? pane : 'main';
    if (event === 'pty.start') runningCommands.set(id, (data as { cmd?: string }).cmd || 'command');
    if (event === 'pty.command') {
      runningCommands.delete(id);
      maybeNotifyCommand(data as { cmd: string; exit: number | null; durMs: number });
      recentCommands.add((data as { cmd?: unknown }).cmd as string);
    }
    if (event === 'pty.cwd' && paneFolders.has(id) && typeof (data as { cwd?: unknown }).cwd === 'string') paneFolders.set(id, (data as { cwd: string }).cwd);
    if (event === 'session.lifecycle') {
      const l = (data as { lifecycle?: unknown } | null)?.lifecycle;
      if (l === 'closed') paneFolders.delete(id);
      else if (l === 'spawned') {
        paneFolders.set(id, '');
        loadPaneFolders(c); // (the event has no folder; the list does)
      }
    }
    if (event === 'pty.exit' || event === 'session.lifecycle') runningCommands.delete(id); // (a fresh shell runs nothing, a closed terminal nothing at all)
    if (event === 'claude.state') onClaudeState((data as { sessions: ClaudeSession[]; today?: DayTotal }).sessions, (data as { today?: DayTotal }).today);
    if (event === 'config.changed') applyConfig(data as typeof appCfg);
    if (event === 'claude.approvals') onApprovals((data as { items?: unknown } | null)?.items);
  });
  void c
    .call('config.get', {})
    .then((x) => applyConfig(x as typeof appCfg))
    .catch(() => undefined);
  loadPaneFolders(c, true);
  c.onClose.on(() => {
    onApprovals([]); // (no answer can reach the terminal any more)
    void onConnectionLost(o);
  });
}

/** Start the app's own terminal host and connect to it. */
async function startTerminal(): Promise<void> {
  const o = await startOwnedDaemon(paths, launcher);
  owned = o;
  client = o.client;
  runningCommands.clear();
  paneFolders.clear();
  prevClaude = []; // a fresh terminal has no Claude yet: nothing of the old one's may count (the quit question, "needs you")
  syncTrayState(); // (nor the menu bar icon)
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
  runningCommands.clear();
  paneFolders.clear();
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

/** Focus mode (⌥⌘F): notifications and the Dock bounce are held, and counted for one summary when it ends. Session state only. */
const focus = new FocusHold();
let lastTerminalNotifyAt = 0;
let prevClaude: ClaudeSession[] = [];
/** The settings the main process acts on itself (kept current from the daemon's config.changed). */
let appCfg: {
  notifications?: { claudeFinished?: boolean };
  claude?: { showCost?: boolean };
  terminal?: { editorUrl?: string };
  appearance?: { systemStats?: boolean; blur?: boolean };
  window?: { closeAction?: string; menuBar?: boolean; menuBarOnly?: boolean; menuBarTitle?: string; hintShown?: boolean; dropdown?: boolean };
  onboarded?: boolean;
  updates?: { seenVersion?: string };
  history?: { names?: string[] };
  permissions?: { trash?: boolean; voice?: boolean };
} = {};

/** A new config: the blur and the system stats are touched only when they changed (every config change would set the vibrancy again). */
function applyConfig(next: typeof appCfg): void {
  const changed = appearanceChanged(appCfg, next);
  const dropdownWas = dropdownOn();
  appCfg = next;
  if (appCfg.permissions?.voice !== true) { voiceEpoch.bump(); void cancelVoiceDownload(); } // (voice off: a running download stops; the files stay until the person removes them)
  if (dropdownWas && !dropdownOn()) restoreBounds();
  if (changed.systemStats) syncSystemStats();
  if (changed.blur) syncVibrancy();
  syncMenuBar();
}

/** The window blurs what is behind it, or not (Settings → Appearance → Blur): at the window's creation and at every change. */
function syncVibrancy(): void {
  if (win && !win.isDestroyed()) win.setVibrancy(vibrancyFor(appCfg));
}

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
  where: whereOf,
  notify: (n) => notify(n.title, n.body, 'finished', n.pane, n.session),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
});

function maybeNotify(n: { title: string; body: string }): void {
  if (win?.isFocused()) return;
  lastTerminalNotifyAt = Date.now();
  notify(n.title || 'Terminal', n.body, 'terminal');
}

let lastBounceAt = 0;
/** A bell while the window is not in front: one gentle bounce of the Dock icon (at most one in five seconds; the terminal's flash stays). Focus mode drops it (a bell is not counted in the summary). */
function maybeBounce(): void {
  if (focus.active || win?.isFocused() || !shouldBounce(Date.now(), lastBounceAt)) return;
  lastBounceAt = Date.now();
  app.dock?.bounce('informational');
}

/** Claude Code works, or waits for the person (from its hooks). */
function claudeBusy(): boolean {
  return prevClaude.some((s) => s.state === 'working' || s.state === 'needs-you');
}

/** Claude, in the terminal, is waiting for the user and they are looking elsewhere. */
function onClaudeState(sessions: ClaudeSession[], today?: DayTotal): void {
  const wasBusy = claudeBusy();
  finished.update(sessions);
  const n = needsYouNotification(prevClaude, sessions, { windowFocused: !!win?.isFocused(), lastTerminalNotifyAt, now: Date.now(), where: whereOf });
  prevClaude = sessions;
  claudeToday = today;
  if (tray && wasBusy && !claudeBusy()) void refreshPastConversations(); // (a finished turn changes the list)
  syncTrayState();
  if (!n || focus.hold('needs-you')) return; // (focus mode: no bounce and no notice, one line in the summary instead)
  app.dock?.bounce('critical');
  notify(n.title, n.body, 'needs-you', n.pane, n.session); // (not held again: focus mode returned above)
}

/**
 * (1.4.0) The weekly digest: once the window has loaded the first time, once per finished week (`usage.digestWeek`), one notification of
 * last week's time with Claude and (with the cost shown) its estimated dollars, and the same line as a toast in the window (`app.digest`)
 * with a button that opens the side panel; `notifications.weeklyDigest` switches both off. The numbers
 * are the daemon's (`usage` in config.json).
 */
let digestAsked = false;
async function weeklyDigest(): Promise<void> {
  const c = client;
  if (digestAsked || !c) return;
  digestAsked = true;
  try {
    const cfg = await c.call<{ usage?: UsageWeeks; notifications?: { weeklyDigest?: boolean }; claude?: { showCost?: boolean } }>('config.get', {});
    const w = cfg.usage ? digestDue(cfg.usage, Date.now()) : null;
    if (!w) return;
    await c.call('config.patch', { usage: { digestWeek: w.id } });
    if (cfg.notifications?.weeklyDigest === false) return;
    const n = digestText(w, cfg.claude?.showCost !== false);
    notify(n.title, n.body, 'digest');
    // and in the window: a toast with the same words and a button that opens the side panel
    sendToRenderer('jaffer:event', 'app.digest', { text: digestLine(w, cfg.claude?.showCost !== false) });
  } catch {
    /* the terminal is gone: there is next week */
  }
}

/** A long command finished while you were looking at something else. */
function maybeNotifyCommand(c: { cmd: string; exit: number | null; durMs: number }): void {
  const n = commandNotification(c, { windowFocused: !!win?.isFocused() });
  if (n) notify(n.title, n.body, c.exit === 0 ? 'command' : 'failed');
}

/**
 * Shows a notification, unless it is of a `kind` focus mode holds (a notification of no kind, the update prompt's, is always shown).
 * "Claude needs you" and "Claude finished" also get a Show button; it and a click on the notification bring the window back, also from
 * the menu bar.
 */
function notify(title: string, body: string, kind?: HoldKind, pane?: string, session?: string): void {
  if (kind && focus.hold(kind)) return;
  if (!Notification.isSupported()) return;
  const withShow = kind === 'needs-you' || kind === 'finished';
  const note = new Notification({ title, body: body.slice(0, 240), ...(withShow ? { actions: [{ type: 'button' as const, text: 'Show' }] } : {}) });
  note.on('click', () => showAndFocus(pane, session));
  if (withShow) note.on('action', () => showAndFocus(pane, session));
  note.show();
}

/**
 * Approvals (1.2.0, `claude.approvals`, off by default): a permission prompt waits for a click. Each new one gets a notification, while the
 * window is not in front and focus mode does not hold it, with Show and Deny. It never offers Allow: that is only in the window's Now
 * card, next to the whole request. Only a click on Deny answers deny. Show brings the window back and lets the hook go ('ask': Claude
 * Code's own prompt appears at once); a click on the notification itself only brings the window back (the hook waits out its time). A notification whose prompt no longer waits is closed. Ids seen while the window was in front get none later.
 */
const approvalNotes = new Map<string, Notification | null>();
function onApprovals(items: unknown): void {
  const list = (Array.isArray(items) ? items : []).filter((a): a is ApprovalView => !!a && typeof (a as ApprovalView).id === 'string');
  const ids = new Set(list.map((a) => a.id));
  for (const [id, note] of approvalNotes) {
    if (ids.has(id)) continue;
    note?.close();
    approvalNotes.delete(id);
  }
  for (const a of list) {
    if (approvalNotes.has(a.id)) continue;
    approvalNotes.set(a.id, null);
    if (win?.isFocused() || focus.hold('needs-you') || !Notification.isSupported()) continue; // (in front: the title bar and the panel ask)
    const asking = prevClaude.find((s) => s.id === a.sessionId);
    const where = asking ? whereOf(asking) : '';
    const note = new Notification({
      title: `Claude asks to use ${String(a.tool).slice(0, 64) || 'a tool'}`,
      body: `${where ? `${where}: ` : ''}${String(a.detail ?? '').slice(0, 120)}`,
      actions: [
        { type: 'button', text: 'Show' },
        { type: 'button', text: 'Deny' },
      ],
    });
    const answer = (decision: 'deny' | 'ask') => void client?.call('claude.approval.answer', { id: a.id, decision }).catch(() => undefined);
    note.on('click', () => showAndFocus(asking?.pane, asking?.id));
    note.on('action', (e, index) => {
      const i = typeof (e as { actionIndex?: unknown })?.actionIndex === 'number' ? (e as { actionIndex: number }).actionIndex : index;
      if (i === 1) answer('deny');
      else {
        answer('ask');
        showAndFocus(asking?.pane, asking?.id);
      }
    });
    approvalNotes.set(a.id, note);
    note.show();
  }
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
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: 'Jaffer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 },
    vibrancy: vibrancyFor(appCfg) ?? undefined,
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  // (1.4.1) The page needs no web permission (camera, notifications, clipboard reads, ...): all are refused. Its own notifications go
  // through main. Two exceptions, both only for the app's own webContents: writing the clipboard (Copy buttons, OSC 52, Copy as image),
  // which may run outside a click, so the page keeps it (reading it stays refused); and, (voice) `media` for the microphone alone
  // (`pageMayUseMic`: audio only, never video, and only while `permissions.voice` is on; read each time, so turning it off ends it).
  const pagePermission = (wc: Electron.WebContents | null, permission: string, mediaTypes?: readonly string[]) => !!win && wc === win.webContents && (permission === 'clipboard-sanitized-write' || pageMayUseMic(appCfg.permissions?.voice === true, permission, mediaTypes));
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details) => cb(pagePermission(wc, permission, 'mediaTypes' in details ? details.mediaTypes : undefined)));
  win.webContents.session.setPermissionCheckHandler((wc, permission, _origin, details) => pagePermission(wc, permission, details.mediaType ? [details.mediaType] : undefined));
  // (voice) The window's session refuses every network request (`requestAllowed`: http(s), ws(s), ftp), from the page, its workers and
  // any library they load. A worker on a `file://` page has no CSP, and a dynamic `import()` of a URL cannot be guarded from JavaScript,
  // so this is the boundary (verified for page and worker fetch, XHR, import, WebSocket and images: scripts/voice-gate.md). Nothing is
  // logged. Not covered, by design: main's own Node `fetch` (the consented model download), `electron-updater` (its own partition) and
  // `shell.openExternal` (which opens the browser).
  win.webContents.session.webRequest.onBeforeRequest({ urls: BLOCKED_URL_FILTER }, (details, cb) => cb({ cancel: !requestAllowed(details.url) }));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    syncSystemStats();
    focus.release(); // (focus mode ends with the window: nothing is left to say it to)
  });
  // a page that loads again (a reload) starts without focus mode
  win.webContents.on('did-finish-load', () => {
    sendToRenderer('jaffer:event', 'app.accessibility', app.isAccessibilitySupportEnabled());
    void focus.release();
    void weeklyDigest();
  });
  // (1.4.1) A page that crashed, or still hangs after HANG_MS, is reloaded: the terminals run on in the daemon, and the page attaches
  // to them again. Also while the window is hidden (showing it again would otherwise show a dead page). `crashAction` decides.
  let hang: NodeJS.Timeout | null = null;
  const calm = () => {
    if (hang) clearTimeout(hang);
    hang = null;
  };
  win.webContents.on('render-process-gone', (_e, d) => {
    calm();
    if (selfCrashed) {
      selfCrashed = false; // (the crash we caused to reload a hung page: it is reloading already)
      return;
    }
    void onPageGone(d.reason);
  });
  win.on('unresponsive', () => {
    hang ??= setTimeout(() => {
      hang = null;
      void onPageGone('unresponsive');
    }, HANG_MS);
  });
  win.on('responsive', calm);
  win.on('closed', calm);
  syncSystemStats();
  const save = () => {
    if (win && !win.isDestroyed() && keepsBounds({ minimized: win.isMinimized(), fullScreen: win.isFullScreen(), dropdown: dropdownOn(), hotkey: !!hotkey })) writeJson(windowFile, win.getBounds());
  };
  win.on('resize', debounce(save, 400));
  win.on('move', debounce(save, 400));
  win.on('focus', () => sendToRenderer('jaffer:focus', true));
  win.on('blur', () => {
    sendToRenderer('jaffer:focus', false);
    // drop-down mode: a click elsewhere puts the window away (only while the hotkey that brings it back is registered; not while a dialog of ours is open, nor in full screen)
    if (dropdownOn() && hotkey && dialogsOpen === 0 && win && !win.isDestroyed() && !win.isFullScreen()) hideWindow();
  });
  // Closing the window (the red ✕, ⌘W) does what Settings say (`closeWindow`): by default it hides, and the terminal runs on while the
  // app does; the menu bar icon, the hotkey and the Dock bring it back, and Quit Jaffer is the way out.
  win.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault();
      closeWindow();
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

/** (1.4.1) A page that still hangs this long after `unresponsive` is reloaded. */
const HANG_MS = 10_000;
/** We crashed the renderer to reload a hung page (`forcefullyCrashRenderer`): the next `render-process-gone`, and only that one, is ours. */
let selfCrashed = false;
/** When the page was reloaded after a crash or a hang (the last few): too many in a minute ask instead (`crashAction`). */
const crashReloads: number[] = [];
let crashAsking = false;

function reloadPage(w: BrowserWindow, hung: boolean): void {
  if (hung) {
    // a hung page cannot reload itself: its renderer is ended first, and the reload then starts a new one
    selfCrashed = true;
    w.webContents.forcefullyCrashRenderer();
  }
  w.webContents.reload();
}

/** The window's page crashed (`reason`, from `render-process-gone`) or hangs (`unresponsive`): reload it, or after too many crashes ask. */
async function onPageGone(reason: string): Promise<void> {
  const w = win;
  if (quitting || crashAsking || !w || w.isDestroyed()) return; // (a page ended by the quit is not a crash)
  if (!app.isPackaged) console.error(`jaffer: the window's page is gone (${reason})`);
  const action = crashAction({ reason, recent: crashReloads, now: Date.now() });
  if (action === 'ignore') return;
  if (action === 'reload') {
    crashReloads.push(Date.now());
    if (crashReloads.length > CRASH_RELOADS) crashReloads.shift();
    reloadPage(w, reason === 'unresponsive');
    return;
  }
  crashAsking = true;
  let r: Electron.MessageBoxReturnValue;
  try {
    const opts = { type: 'warning' as const, ...CRASH_DIALOG, buttons: [...CRASH_DIALOG.buttons] };
    if (!w.isVisible()) showWindow(); // in front, as a sheet on the window (as the quit question): a hidden one would leave it behind other apps
    r = await dialog.showMessageBox(w, opts);
  } finally {
    crashAsking = false;
  }
  if (quitting || w.isDestroyed()) return;
  if (r.response === 0) {
    crashReloads.length = 0;
    reloadPage(w, reason === 'unresponsive');
  } else {
    // the person chose Quit in a question about the crash: nothing more to ask (as after a crash of the terminal)
    quitConfirmed = true;
    app.quit();
  }
}

function showWindow(): void {
  cancelHide?.();
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (dockHidden) app.focus({ steal: true }); // (an app without a Dock icon is not brought to the front by show() alone)
  }
  if (!dockHidden) app.dock?.show(); // (Settings → Only in the menu bar keeps the Dock icon away)
}

/** The hotkey and a click on the menu bar icon: a window in front hides, any other is shown. */
function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) hideWindow();
  else showWindow();
}

const dropdownOn = (): boolean => appCfg.window?.dropdown === true;

/** The hotkey: as `toggleWindow`, but in drop-down mode the window first slides to the top of the display under the cursor (not one in full screen). */
function hotkeyToggle(): void {
  if (!dropdownOn() || (win && !win.isDestroyed() && win.isFullScreen())) return toggleWindow();
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return hideWindow();
  const fresh = !win || win.isDestroyed();
  if (fresh) showWindow(); // (makes the window, which shows itself on ready-to-show as always)
  win?.setBounds(dropdownBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea), false);
  if (!fresh) showWindow();
}

/** Drop-down mode turned off: the window goes back to the bounds it had (window.json was not touched meanwhile), or to the first-start size, centred, when none (or no place) was saved. In full screen: once it leaves it. */
function restoreBounds(): void {
  if (!win || win.isDestroyed()) return;
  win.removeListener('leave-full-screen', restoreAfterFullScreen);
  if (win.isFullScreen()) return void win.once('leave-full-screen', restoreAfterFullScreen);
  const b = loadBounds();
  if (b && typeof b.x === 'number' && typeof b.y === 'number') return win.setBounds(b, false);
  win.setSize(b?.width ?? 1280, b?.height ?? 820, false);
  win.center();
}
const restoreAfterFullScreen = (): void => void (!dropdownOn() && restoreBounds());

/** A hide that waits for the window to leave full screen; showing the window again calls it off. */
let cancelHide: (() => void) | null = null;

/**
 * Hides the window. One in full screen leaves it first (hidden in full screen it would leave an empty Space with nothing to click):
 * macOS animates that, so it hides once it has left, or after 2 s if the event never comes. `hint`: a close (✕, ⌘W), whose first
 * hide says where Jaffer went.
 */
function hideWindow(hint = false): void {
  const w = win;
  if (!w || w.isDestroyed()) return;
  if (hint) maybeHideHint();
  cancelHide?.();
  if (!w.isFullScreen()) return w.hide();
  const done = () => {
    cancelHide?.();
    if (!w.isDestroyed()) w.hide();
  };
  const timer = setTimeout(done, 2_000);
  w.once('leave-full-screen', done);
  cancelHide = () => {
    clearTimeout(timer);
    w.removeListener('leave-full-screen', done);
    cancelHide = null;
  };
  w.setFullScreen(false);
}

/** The red ✕ and ⌘W (Settings → When I close the window: hide to the menu bar, quit, or ask). */
function closeWindow(): void {
  const d = closeDecision({ action: appCfg.window?.closeAction ?? 'menubar', fullScreen: !!win?.isFullScreen(), menuBar: !!tray, running: claudeBusy() || runningCommands.size > 0 });
  if (d === 'quit') quitFromMenu();
  else if (d === 'ask') void askOnClose();
  else hideWindow(true); // ('hide', or 'leave-full-screen-then-hide': hideWindow leaves full screen first)
}

let askingToClose = false;
/** Hide to Menu Bar, Quit Jaffer or Cancel (the default: Return and Esc leave the window where it is). */
async function askOnClose(): Promise<void> {
  if (askingToClose || !win || win.isDestroyed()) return;
  askingToClose = true;
  try {
    const r = await dialog.showMessageBox(win, { type: 'question', message: CLOSE_ASK.message, detail: CLOSE_ASK.detail, buttons: [...CLOSE_ASK.buttons], defaultId: CLOSE_ASK.defaultId, cancelId: CLOSE_ASK.cancelId });
    if (r.response === 0) hideWindow(true);
    else if (r.response === 1) quitFromMenu();
  } finally {
    askingToClose = false;
  }
}

/** The first time the window hides while the menu bar icon is there: one notification says where Jaffer went (`window.hintShown`). */
function maybeHideHint(): void {
  if (!tray || appCfg.window?.hintShown === true) return;
  appCfg = { ...appCfg, window: { ...appCfg.window, hintShown: true } }; // (at once: a second close before the daemon answers says nothing)
  notify(HIDE_HINT.title, HIDE_HINT.body);
  void client?.call('config.patch', { window: { hintShown: true } }).catch(() => undefined);
}

/** The menu's Quit Jaffer (⌘Q), the menu bar's, and a close set to quit: the one quit that may ask first (see before-quit). */
function quitFromMenu(): void {
  askOnQuit = true;
  app.quit();
}

async function syncHotkey(): Promise<void> {
  try {
    const cfg = await client?.call('config.get', {});
    const want: string = cfg?.hotkey ?? '';
    if (want === hotkey) return;
    if (hotkey) globalShortcut.unregister(hotkey);
    hotkey = '';
    if (want && globalShortcut.register(want, hotkeyToggle)) hotkey = want;
  } catch {
    /* hotkey is optional */
  }
}

// ---------------------------------------------------------------- menu

function buildMenu(): void {
  // a menu item that runs the window's action of the same id (labels and accelerators: shared/menu-spec.ts)
  const item = (id: string): MenuItemConstructorOptions => ({ ...MENU_ITEMS[id], click: () => sendToRenderer('jaffer:menu', id) });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Jaffer',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void manualUpdateCheck() },
        { type: 'separator' },
        item('settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // ⌘Q ends the terminal and asks first when something runs (before-quit). Not `role: 'quit'`: only this item marks its quit as
        // one that may ask; a quit the system starts (logout, restart, shut down, the Dock's Quit) must never wait on a question.
        { label: 'Quit Jaffer', accelerator: 'Cmd+Q', click: quitFromMenu },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        item('hide-window'),
        { type: 'separator' },
        item('clear'),
        item('find'),
        item('find-next'),
        item('find-prev'),
        item('copy-markdown'),
        { type: 'separator' },
        item('prompt-prev'),
        item('prompt-next'),
        item('recent-commands'),
        item('history'),
        item('resume-last'),
        item('pin-selection'),
        item('focus-mode'),
        { type: 'separator' },
        item('run-claude'),
        item('restart-shell'),
        { type: 'separator' },
        item('split-terminal'),
        item('close-terminal'),
        item('zoom-terminal'),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('palette'),
        item('toggle-panel'),
        { type: 'separator' },
        item('next-terminal'),
        item('prev-terminal'),
        item('focus-terminal-1'),
        item('focus-terminal-2'),
        item('focus-terminal-3'),
        item('focus-terminal-4'),
        { type: 'separator' },
        item('zoom-in'),
        item('zoom-out'),
        item('zoom-reset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        item('whats-new'),
        item('shortcuts'),
        item('glossary'),
        item('start-tour'),
        { label: 'Jaffer on GitHub', click: () => void shell.openExternal('https://github.com/jafforgehq/jaffer') },
        { label: 'Reveal Session Folder', click: () => void shell.openPath(paths.home) },
        { label: 'Show Log', click: () => void shell.openPath(paths.logFile) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- the menu bar item (Settings → Show Jaffer in the menu bar)

let tray: Tray | null = null;
let trayPlayer: TrayIconPlayer | null = null;
/** The Dock icon is hidden (Settings → Only in the menu bar, which needs the menu bar icon). */
let dockHidden = false;
/** What the answers finished today cost, from the daemon's `claude.state` (for the menu bar text). */
let claudeToday: DayTotal | undefined;
/** The last five commands that finished, for the menu (memory only; never a sensitive one). */
const recentCommands = new RecentCommands();
/** The newest past Claude conversations for the menu bar's submenu (ids, folders, times and the redacted titles; memory only). Refreshed in the background. */
let pastConversations: Conversation[] = [];
let pastBusy: Promise<void> | null = null;
function refreshPastConversations(): Promise<void> {
  pastBusy ??= (client?.call<{ items?: Conversation[] }>('claude.history', {}, 10_000) ?? Promise.resolve(undefined))
    .then((r) => void (Array.isArray(r?.items) && (pastConversations = r.items)))
    .catch(() => undefined)
    .finally(() => void (pastBusy = null));
  return pastBusy;
}
/** Ticks the menu bar text every second, only while it shows the running turn's time and a turn runs. */
let titleTimer: NodeJS.Timeout | null = null;
const trayImages = new Map<TrayFrame, Electron.NativeImage>();

/** A frame of the icon, a template image (macOS tints it for the menu bar) at 1x and 2x. Throws when it cannot be made. */
function trayImage(frame: TrayFrame): Electron.NativeImage {
  let img = trayImages.get(frame);
  if (!img) {
    img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${TRAY_ICONS[frame].x1}` });
    img.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICONS[frame].x2}` });
    if (img.isEmpty()) throw new Error(`tray icon ${frame} did not load`);
    img.setTemplateImage(true);
    trayImages.set(frame, img);
  }
  return img;
}

/** The icon is there while the setting is on (and not while the app quits); the Dock icon follows; the icon and its text show the state. */
function syncMenuBar(): void {
  const want = appCfg.window?.menuBar !== false && !quitting;
  if (want && !tray) {
    try {
      tray = new Tray(trayImage('idle'));
      tray.setToolTip('Jaffer');
      tray.on('click', () => toggleWindow());
      tray.on('right-click', (e) => void openTrayMenu(!!e.altKey).catch(() => undefined));
      void refreshPastConversations(); // (the first right click already has the list)
      trayPlayer = new TrayIconPlayer({
        show: (f) => {
          try {
            tray?.setImage(trayImage(f));
          } catch {
            /* the frame before stays */
          }
        },
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (x) => clearTimeout(x as NodeJS.Timeout),
      });
    } catch {
      destroyTray(); // (no icon, no crash: the window and the Dock work as before)
    }
  } else if (!want && tray) destroyTray();
  syncTrayState();
  syncDock();
}

function destroyTray(): void {
  trayPlayer?.destroy();
  trayPlayer = null;
  if (titleTimer) clearInterval(titleTimer);
  titleTimer = null;
  tray?.destroy();
  tray = null;
}

/** Only in the menu bar hides the Dock icon, and only while the menu bar icon is there to come back to. */
function syncDock(): void {
  const hide = !!tray && appCfg.window?.menuBarOnly === true;
  if (hide === dockHidden || !app.dock) return;
  dockHidden = hide;
  if (hide) app.dock.hide();
  else void app.dock.show();
}

/** The icon (idle, working, alert) and the text beside it, from the last `claude.state`. */
function syncTrayState(): void {
  if (!tray) return;
  trayPlayer?.set(trayState(prevClaude));
  syncTrayTitle();
}

function syncTrayTitle(): void {
  const mode = (appCfg.window?.menuBarTitle ?? 'off') as MenuBarTitle;
  tray?.setTitle(trayTitle(mode, { sessions: prevClaude, today: claudeToday, now: Date.now(), showCost: appCfg.claude?.showCost !== false }), { fontType: 'monospacedDigit' });
  const tick = !!tray && mode === 'time' && trayState(prevClaude) !== 'idle';
  if (tick && !titleTimer) titleTimer = setInterval(syncTrayTitle, 1_000);
  else if (!tick && titleTimer) {
    clearInterval(titleTimer);
    titleTimer = null;
  }
}

/** The menu, built when it opens (so its status lines are current); with ⌥ held, more lines (and the repository's counts). */
async function openTrayMenu(alt: boolean): Promise<void> {
  if (!tray) return;
  const git = alt ? await client?.call<{ git?: GitStatus }>('session.info', {}, 1_000).then((i) => i?.git).catch(() => undefined) : undefined;
  if (!tray) return;
  // never block the menu: the last list is used if the daemon is slow (400 ms), and the refresh goes on in the background
  await Promise.race([refreshPastConversations(), sleep(400)]);
  if (!tray) return;
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  const recent = recentCommands.list();
  const past = historyMenuItems(pastConversations, os.homedir(), Date.now(), parseNames(appCfg.history?.names));
  const template: MenuItemConstructorOptions[] = [
    ...trayMenuLines(prevClaude, Date.now(), { alt, showCost: appCfg.claude?.showCost !== false, git }).map((label) => ({ label, click: () => showWindow() })),
    { type: 'separator' },
    ...(unseenNotes(RELEASE_NOTES, effectiveSeen({ seenVersion: appCfg.updates?.seenVersion, onboarded: appCfg.onboarded }, VERSION), VERSION).length
      ? [{ label: `What's New in ${VERSION}`, click: () => { showWindow(); sendToRenderer('jaffer:menu', 'whats-new'); } } as MenuItemConstructorOptions]
      : []),
    visible ? { label: 'Hide Jaffer', click: () => hideWindow() } : { label: 'Show Jaffer', click: () => showWindow() },
    {
      label: 'Recent Commands',
      // a click copies the command (nothing is typed): paste it in the terminal
      submenu: recent.length ? recent.map((c) => ({ label: c.label, click: () => clipboard.writeText(c.raw) })) : [{ label: 'No commands yet', enabled: false }],
    },
    // the newest conversations right in the menu (not behind a submenu): a click copies `claude --resume <id>` (nothing is typed), paste it in the terminal
    { type: 'separator' },
    { label: 'Past Claude Conversations', enabled: false },
    ...(past.length
      ? past.map((c): MenuItemConstructorOptions => ({ label: c.label, click: () => { const cmd = resumeCommand(c.id); if (cmd) clipboard.writeText(cmd); } }))
      : [{ label: 'No conversations found', enabled: false } as MenuItemConstructorOptions]),
    { label: 'All Past Conversations…', accelerator: 'Shift+Cmd+O', click: () => { showWindow(); sendToRenderer('jaffer:menu', 'history'); } },
    { type: 'separator' },
    { label: 'Focus Mode', type: 'checkbox', checked: focus.active, click: () => sendToRenderer('jaffer:menu', 'focus-mode') },
    {
      label: 'Settings…',
      click: () => {
        showWindow();
        sendToRenderer('jaffer:menu', 'settings');
      },
    },
    { type: 'separator' },
    { label: 'Quit Jaffer', click: quitFromMenu },
  ];
  tray.popUpContextMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- ipc

function trusted(e: Electron.IpcMainInvokeEvent): boolean {
  return isAppUrl(e.senderFrame?.url, indexUrl) && !!win && e.sender === win.webContents;
}

ipcMain.handle('jaffer:call', async (e, method: string, params: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (!pageMayCall(method)) throw new Error(NOT_ALLOWED); // (1.4.1) only the methods the page uses: never a hook's, never hello
  if (!client || !client.connected) throw new Error('The terminal is not running.');
  const long = method.startsWith('setup.') || method === 'claude.explain' || method === 'claude.mcp'; // (Explain's helper may take up to a minute; the MCP check 25 s plus finding claude)
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
  const r = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask);
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
// Focus mode from the window (⌥⌘F, the palette): on holds notifications; off shows the one sentence about what was held, if anything.
ipcMain.handle('jaffer:focus-mode', (e, on: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (on === true) return void focus.start();
  const said = focus.release();
  if (said) notify('Focus mode ended', said);
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

// (1.3.0) Past conversations to the Trash: the page names ids only; the files come from `conversationFiles`, the person is asked here
// (a native dialog, Cancel the default), a conversation still running is refused, and nothing is ever deleted outright.
ipcMain.handle('jaffer:trash-conversations', async (e, p: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const ids = (p as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length > MAX_REMOVE || !ids.every((x) => typeof x === 'string')) throw new Error('Not a list of conversations.');
  return trashConversations(ids, {
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), // (as the daemon reads the list)
    enabled: () => appCfg.permissions?.trash !== false, // (Settings → Privacy and permissions; the page hides the buttons, main refuses anyway)
    trashItem: (f) => shell.trashItem(f),
    confirm: async (n) => {
      const ask = trashAsk(n);
      const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask);
      return r.response === 0;
    },
    liveIds: async () => {
      if (!client || !client.connected) throw new Error('The terminal is not running.');
      const s = await client.call<{ sessions: ClaudeSession[] }>('claude.state', {}, 10_000);
      return s.sessions.filter((x) => x.state !== 'ended').map((x) => x.id);
    },
  });
});

// ---------------------------------------------------------------- voice (Settings → Privacy and permissions → Voice, off by default)
// The model files live in `<Jaffer home>/voice`. The page asks main to fetch (one download at a time), read and remove them; main refuses
// both the download and the read unless the daemon's own config says `permissions.voice` (read at each call: the page patches the config
// and calls right after, before `config.changed` reaches main). Events to the page carry numbers and a code, never a path or a message.
const voiceDir = path.join(paths.home, 'voice');
const voiceEpoch = new VoiceEpoch(); // (a cancel, a remove or Voice turned off while the config is being read keeps the download from starting)
let voiceJob: { ctl: AbortController; settled: Promise<void> } | null = null;
async function voiceAllowed(): Promise<boolean> {
  try { return ((await client?.call<typeof appCfg>('config.get', {}))?.permissions?.voice) === true; } catch { return false; }
}
async function cancelVoiceDownload(): Promise<void> {
  const j = voiceJob;
  if (!j) return;
  j.ctl.abort();
  await j.settled;
}
ipcMain.handle('jaffer:voice-status', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  return voiceStatus(voiceDir);
});
ipcMain.handle('jaffer:voice-download', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  if (voiceJob) return; // (one at a time: the running one reports to the page)
  const t = voiceEpoch.take();
  if (!(await voiceAllowed())) throw new Error('Voice is off.');
  if (voiceJob || !voiceEpoch.still(t)) return; // (a second ask arrived while the config was read)
  const ctl = new AbortController();
  const settled = downloadVoice(voiceDir, { signal: ctl.signal, onProgress: (done, total) => sendToRenderer('jaffer:event', 'voice.progress', { done, total }) })
    .then(() => sendToRenderer('jaffer:event', 'voice.done', {}))
    .catch((err) => sendToRenderer('jaffer:event', 'voice.error', { code: err instanceof VoiceDownloadError ? err.code : 'unknown' }))
    .finally(() => { voiceJob = null; });
  voiceJob = { ctl, settled };
  await settled;
});
ipcMain.handle('jaffer:voice-cancel', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  voiceEpoch.bump();
  await cancelVoiceDownload();
});
ipcMain.handle('jaffer:voice-file', async (e, p: unknown) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  const name = (p as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') throw new Error('Not a voice file.');
  if (!(await voiceAllowed())) throw new Error('Voice is off.');
  // the onnxruntime-web binary ships with the app (the build copies it next to the page); a fixed name, never a path from the page
  if (name === VOICE_RUNTIME_WASM) return new Uint8Array(await fs.promises.readFile(path.join(distRoot, 'renderer', VOICE_RUNTIME_WASM)));
  return readVoiceFile(voiceDir, name); // (refuses a name the manifest does not list)
});
// macOS's own microphone access (System Settings → Privacy & Security → Microphone): asked only when it was never decided, and only while
// Voice is on (the daemon's config, as for the files). Never throws: any failure is 'denied'. The page's own permission is `pageMayUseMic`.
ipcMain.handle('jaffer:voice-mic', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  try {
    if (!(await voiceAllowed())) return 'denied';
    const s = systemPreferences.getMediaAccessStatus('microphone');
    if (s === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    return s === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
});
ipcMain.handle('jaffer:voice-remove', async (e) => {
  if (!trusted(e)) throw new Error('untrusted sender');
  voiceEpoch.bump();
  await cancelVoiceDownload();
  await removeVoice(assertVoiceDir(voiceDir, os.homedir())); // (rm -rf only ever of <Jaffer home>/voice)
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
  // (1.4.1) VoiceOver or another assistive technology starts or stops: the terminal's screen reader mode follows (Settings → Appearance)
  app.on('accessibility-support-changed', (_e, enabled) => sendToRenderer('jaffer:event', 'app.accessibility', enabled));
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
    const hello = (await client!.call('hello', {})) as { version: string; pid: number };
    if (hello.pid !== owned?.pid) return fail(`the terminal (pid ${hello.pid}) is not the app's own child (${owned?.pid})`);
    // (1.4.1) the page may call only the methods it uses
    const refused = await js<boolean>('window.jaffer.call("hello", {}).then(() => false, (e) => String(e).includes("Not allowed."))');
    if (!refused) return fail('the page could call a method that is not on its list');
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
      const snap = (await client!.call('session.snapshot', {})) as { data: string };
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
    const ask = childEnded ? null : quitNeedsConfirm(quitState(runningCommands.values(), claudeBusy()));
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
  destroyTray();
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


