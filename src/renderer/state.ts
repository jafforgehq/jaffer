import { batch, effect, signal } from '@preact/signals';
import type { JafferConfig } from '../shared/config';
import type { ClaudeSession } from '../core/claude/watcher';
import type { UpdateState } from '../shared/update-policy';
import { Emitter } from '../shared/emitter';
import { isSensitiveCommand, redactText } from '../shared/redact';
import { COMMAND_HEAD } from '../shared/process-badge';
import { fmtAgo, tildeOf } from '../shared/history-label';
import { RELEASE_NOTES } from '../generated/release-notes';
import { effectiveSeen, unseenNotes, type ReleaseNote } from '../shared/whats-new';
import type { GitStatus } from '../core/session/git-status';
import type { Conversation } from '../core/claude/history';
import { baseName, fmtDuration, turnCounts, turnSummaryText } from './claude-ui';
import { FailTracker } from './fail-tracker';
import { resolveTheme, type JafferTheme } from './themes';

export { fmtDuration };

const jaffer = () => window.jaffer;

// ------------------------------------------------------------------ session & ui

export interface SessionInfo {
  cwd: string;
  project?: string;
  branch?: string;
  busy?: string | null;
  /** When the running command started (ms since epoch). */
  busySince?: number | null;
  version?: string;
  startedAt?: string;
  /** The folder's repository, counted (after each prompt); absent outside one. */
  git?: GitStatus;
}

export type Overlay = null | 'settings' | 'palette' | 'onboarding' | 'find' | 'recent' | 'keys';

export const cfg = signal<JafferConfig | null>(null);
export const daemonUp = signal(true);
export const ready = signal(false);
export const info = signal<SessionInfo>({ cwd: '' });
export const activePane = signal('main');
/** A slow clock for relative times ("2m ago") without a timer per component. */
export const clock = signal(Date.now());
setInterval(() => (clock.value = Date.now()), 15_000);
export const overlay = signal<Overlay>(null);
/** Open a dialog, but not over the first-run screen: that has to be answered, and a shortcut would replace it and leave first run unfinished. */
export function openOverlay(next: Exclude<Overlay, 'onboarding' | null>): void {
  if (overlay.value === 'onboarding') return;
  overlay.value = next;
}
export const windowFocused = signal(true);
/** When Claude last worked or asked for the person, or a command last started or ended (ms since epoch): the companion dozes after ten quiet minutes. */
export const lastActivityAt = signal(Date.now());
/** When a command last worked after three failures in a row (the companion's "Fixed it!" burst), and when a bell last rang (its flinch); 0 = never. */
export const fixedAt = signal(0);
export const bellAt = signal(0);
const failTracker = new FailTracker();
/** A bell rings again at once when a program rings in a loop: the companion flinches at most once in this long. */
const BELL_GAP_MS = 2000;
export const appVersion = signal('');
/** Focus mode (⌥⌘F): the title bar, the tool strip, the pins and the companion fade, and the app holds its notifications. Session only. */
export const focusMode = signal(false);
export function setFocusMode(on: boolean): void {
  focusMode.value = on;
  void Promise.resolve(window.jaffer.setFocusMode?.(on)).catch(() => undefined);
}
/** For Settings → Appearance → Follow macOS / time of day: whether macOS is dark, and the hour (0..23); the window keeps them current while the setting needs them. */
export const systemDark = signal(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true);
export const hour = signal(new Date().getHours());
/** The theme that is on now: the chosen one, or the light one by macOS or by the hour. Reads signals, so an effect that calls it follows them. */
export function activeTheme(): JafferTheme {
  const a = cfg.value?.appearance;
  return resolveTheme({ autoTheme: a?.autoTheme ?? 'off', theme: a?.theme ?? '', lightTheme: a?.lightTheme ?? '', systemDark: systemDark.value, hour: hour.value });
}
/** Where the self-update stands (Settings → Updates). Null until the app answers. */
export const updateState = signal<UpdateState | null>(null);

// ------------------------------------------------------------------ terminal power (memory only: nothing here is written anywhere)

export interface RecentCommand {
  cmd: string;
  exit: number | null;
  at: number;
  durMs: number;
  /** The shell's folder when it ended (redacted, at most 4096 characters), for ⌘R by folder. */
  cwd?: string;
}
/** This session's commands for ⌘R (newest first, at most 200). A sensitive command is never kept, and one longer than a command's head is left out. */
export const commands = signal<RecentCommand[]>([]);
/** The last thing searched for, so ⌘G / ⇧⌘G work with the find bar closed. */
export const lastFind = signal('');
/** Lines pinned under the title bar (⇧⌘L), at most 3, already redacted. */
export const pins = signal<{ id: number; text: string }[]>([]);
/** The latest local server port the running command printed; gone when it ends. */
export const port = signal<number | null>(null);
/** A paste of several lines, waiting for Paste or Cancel. */
export const pasteAsk = signal<{ text: string; lines: number; first: string } | null>(null);

/** How many lines a paste has: `\r\n`, `\n` and a lone `\r` each end one; a trailing break does not start another. */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
    if ((c === 10 || c === 13) && i < text.length - 1) n++;
  }
  return n;
}
/** The first line of a paste (of its head: a paste can be any size). */
export const firstLine = (text: string): string => text.slice(0, 4 * COMMAND_HEAD).split(/\r\n|\r|\n/)[0]!;

let pinId = 1;
export function addPin(text: string): void {
  pins.value = [...pins.value.slice(-2), { id: pinId++, text }];
}

export function remember(c: RecentCommand): void {
  if (!c.cmd.trim() || c.cmd.length > 4 * COMMAND_HEAD || isSensitiveCommand(c.cmd)) return;
  const cwd = typeof c.cwd === 'string' && c.cwd ? redactText(c.cwd.slice(0, 4 * COMMAND_HEAD)).slice(0, 4096) : undefined;
  commands.value = [{ ...c, cwd }, ...commands.value.filter((x) => x.cmd !== c.cmd)].slice(0, 200);
}

/** Feature 9: the toast for long commands that finished while the window was away, the most recent first. */
export function awayText(done: { cmd: string; exit: number | null; durMs: number }[]): string {
  const c = done[0]!;
  const shown = safeCommand(c.cmd);
  const name = shown === '(hidden)' ? 'A command' : shown.replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${name} finished in ${fmtDuration(c.durMs)}${typeof c.exit === 'number' ? ` (exit ${c.exit})` : ''}${done.length > 1 ? ` and ${done.length - 1} more` : ''}`;
}
/** Commands of 30 s or more that finished while the window was not focused, newest first. */
let away: { cmd: string; exit: number | null; durMs: number }[] = [];

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
  /** Buttons under the text (the files a turn edited: a click reveals one). */
  actions?: { label: string; run: () => void }[];
  /** Plain text after the buttons ("+2 more"). */
  note?: string;
}
export const toasts = signal<Toast[]>([]);
let toastId = 1;
/** Shows a toast for `ttl` ms (longer when it has buttons), or until it is dismissed; returns its id, for `dismissToast`. */
export function toast(t: Omit<Toast, 'id'>, ttl = t.actions?.length ? 10_000 : 6000): number {
  const id = toastId++;
  toasts.value = [...toasts.value.slice(-3), { ...t, id }];
  setTimeout(() => dismissToast(id), ttl);
  return id;
}
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ------------------------------------------------------------------ Claude

export interface ClaudeAuthState {
  installed: boolean;
  loggedIn: boolean;
  loginRunning: boolean;
  loginError?: string;
}
/** What the Claude in the terminal is doing, pushed by the daemon from its hook events (newest change first). */
export const claudeLive = signal<ClaudeSession[]>([]);
/** The Claude session the mole and the title bar follow: the most recently changed one that has not ended. */
export const currentClaude = (): ClaudeSession | null => claudeLive.value.find((s) => s.state !== 'ended') ?? null;
async function loadClaudeState(): Promise<void> {
  try {
    setClaude(await jaffer().call('claude.state', {}));
  } catch {
    /* the daemon is not there yet; its next push fills this in */
  }
}

// Everything below is memory only: it ends with the window.
/** What the answers finished today cost (the daemon's estimate; it starts again at local midnight), for the daily budget, and how long they took. */
export const claudeToday = signal<{ usd: number; date: string; workMs?: number } | null>(null);
/** The last 20 finished turns: how long each took and, once it is known, what it cost (the cost chip's sparklines). */
export const turnHistory = signal<{ id: string; durMs: number; usd?: number }[]>([]);
/** A turn just finished: the window's edge flashes once. */
export const turnDone = signal(false);
/** A clock that ticks every second, only while Claude works (the ring's progress, the running tool call's segment). */
export const tick = signal(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
effect(() => {
  const on = currentClaude()?.state === 'working';
  if (on && !ticker) {
    tick.value = Date.now();
    ticker = setInterval(() => (tick.value = Date.now()), 1000);
  } else if (!on && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
});
/** How many times a permission prompt was answered, per session and tool (`id \n tool`). */
const answered = new Map<string, number>();
export const timesAnswered = (sessionId: string, tool: string): number => answered.get(`${sessionId}\n${tool}`) ?? 0;

let seen: ClaudeSession | null = null;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
/** A finished turn's summary, waiting (up to 3 s) for the turn's cost. */
let pending: { id: string; durMs: number; counts: Record<string, number>; files: string[]; timer: ReturnType<typeof setTimeout> } | null = null;

/** A `claude.state` from the daemon (or a test: any field may be missing), and what its changes to the current session mean. */
function setClaude(data: { sessions?: ClaudeSession[]; today?: { usd: number; date: string; workMs?: number } } | null | undefined): void {
  batch(() => {
    claudeLive.value = Array.isArray(data?.sessions) ? data.sessions : [];
    claudeToday.value = typeof data?.today?.usd === 'number' ? data.today : null;
    if (claudeLive.value.some((c) => c?.state === 'working' || c?.state === 'needs-you')) lastActivityAt.value = Date.now();
  });
  const s = currentClaude();
  const p = s && seen?.id === s.id ? seen : null;
  seen = s;
  if (!s) return;
  if (p && s.compacting && !p.compacting) toast({ kind: 'info', text: 'Claude is compacting its context' });
  const asked = p?.tool?.name;
  if (p?.state === 'needs-you' && s.state === 'working' && asked) answered.set(`${s.id}\n${asked}`, timesAnswered(s.id, asked) + 1);
  const cost = s.cost && s.cost.at !== p?.cost?.at ? s.cost.last : undefined;
  if (p?.state === 'working' && s.state === 'idle' && !s.cutShort) turnFinished(s, cost?.usd, !!cost);
  else if (cost) {
    const h = turnHistory.value;
    const last = h[h.length - 1];
    if (last?.id === s.id && last.usd === undefined) turnHistory.value = [...h.slice(0, -1), { ...last, usd: cost.usd }];
    if (pending?.id === s.id) showSummary(cost.usd);
  }
}

function turnFinished(s: ClaudeSession, usd: number | undefined, costKnown: boolean): void {
  turnDone.value = true;
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => (turnDone.value = false), 1200);
  const durMs = s.since - (s.turnStartedAt as number);
  if (!Number.isFinite(durMs) || durMs < 0) return; // (no times to tell how long it took: nothing to say)
  turnHistory.value = [...turnHistory.value, { id: s.id, durMs, usd }].slice(-20);
  if (pending) showSummary(undefined); // an earlier turn's summary still waiting: it goes as it is
  if (cfg.value?.claude?.turnSummary === false || durMs < 10_000) return;
  const counts = turnCounts(s.calls, s.turnStartedAt);
  // (a turn without a prompt keeps the last prompt's files: only a turn that wrote lists them)
  const files = counts.write && Array.isArray(s.files) ? s.files : [];
  pending = { id: s.id, durMs, counts, files, timer: setTimeout(() => showSummary(undefined), 3000) };
  if (costKnown || cfg.value?.claude?.showCost === false) showSummary(usd);
}

function showSummary(usd: number | undefined): void {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  const shown = p.files.slice(0, 5);
  toast({
    kind: 'info',
    text: turnSummaryText({ durMs: p.durMs, counts: p.counts, usd: cfg.value?.claude?.showCost === false ? undefined : usd }),
    actions: shown.map((f) => ({ label: baseName(f), run: () => void jaffer().revealPath(f).catch(() => undefined) })),
    note: p.files.length > shown.length ? `+${p.files.length - shown.length} more` : undefined,
  });
}

/** CPU and memory in use (0..1), from the app every 5 s while Settings → Appearance → System stats is on. */
export const systemStats = signal<{ cpu: number; mem: number } | null>(null);
effect(() => {
  if (cfg.value?.appearance?.systemStats !== true) systemStats.value = null; // switched on again, only a new sample shows
});

// ------------------------------------------------------------------ pty bus (consumed by terminal views)

export const ptyBus = new Emitter<{ event: string; data: any }>();

// ------------------------------------------------------------------ bootstrap

async function refreshInfo(): Promise<void> {
  try {
    const i = await jaffer().call('session.info', {});
    batch(() => {
      const { recentCommands: _recent, panes: _panes, ...rest } = i as SessionInfo & { panes?: unknown; recentCommands?: unknown };
      info.value = { ...info.value, project: undefined, branch: undefined, git: undefined, ...rest }; // (the answer leaves out what there is none of: outside a repository there is no branch, not the last one)
    });
  } catch {
    /* ignore */
  }
}

export async function bootstrap(): Promise<void> {
  const j = jaffer();
  j.onEvent((event, data) => {
    if (event.startsWith('pty.')) {
      ptyBus.emit({ event, data });
      if (event === 'pty.start') {
        lastActivityAt.value = Date.now();
        if (data.pane === 'main') {
          info.value = { ...info.value, busy: data.cmd || 'command', busySince: Date.now() };
          port.value = null;
        }
        void refreshInfoSoon();
      } else if (event === 'pty.command') {
        lastActivityAt.value = Date.now();
        info.value = { ...info.value, busy: null, busySince: null };
        if (data.pane === 'main') {
          port.value = null;
          if (failTracker.record(String(data.cmd ?? ''), typeof data.exit === 'number' ? data.exit : null)) fixedAt.value = Date.now();
          remember({ cmd: String(data.cmd ?? ''), exit: data.exit ?? null, at: Date.now(), durMs: Number(data.durMs) || 0, cwd: typeof data.cwd === 'string' && data.cwd ? data.cwd : info.value.cwd });
          if (Number(data.durMs) >= 30_000 && !windowFocused.value) away = [{ cmd: String(data.cmd ?? ''), exit: data.exit ?? null, durMs: Number(data.durMs) }, ...away].slice(0, 50);
        }
        void refreshInfoSoon();
      } else if (event === 'pty.bell') {
        const now = Date.now();
        if (now - bellAt.value >= BELL_GAP_MS) bellAt.value = now;
      } else if (event === 'pty.cwd') {
        info.value = { ...info.value, cwd: data.cwd };
        void refreshInfoSoon();
      } else if (event === 'pty.prompt' && data.pane === 'main') {
        // the daemon counts the repository after each prompt (debounced, git takes up to a second): read it once that is done
        if (gitTimer) clearTimeout(gitTimer);
        gitTimer = setTimeout(() => void refreshInfo(), 1500);
      }
    } else if (event === 'claude.state') setClaude(data);
    else if (event === 'update.state') updateState.value = data;
    else if (event === 'config.changed') cfg.value = data;
    else if (event === 'session.lifecycle') void refreshInfo();
    else if (event === 'daemon.down') daemonUp.value = false;
    else if (event === 'daemon.up') {
      daemonUp.value = true;
      void refreshInfo();
      void loadClaudeState();
      ptyBus.emit({ event: 'daemon.up', data: {} });
    }
  });
  j.onFocus((f) => {
    windowFocused.value = f;
    if (f && away.length) {
      toast({ kind: 'info', text: awayText(away) }, 9000);
      away = [];
    }
  });
  j.onSystemStats?.((st) => cfg.value?.appearance?.systemStats === true && (systemStats.value = st));
  const [config, app] = await Promise.all([j.call('config.get', {}), j.appInfo()]);
  batch(() => {
    cfg.value = config;
    appVersion.value = app.version;
    overlay.value = config.onboarded ? null : 'onboarding';
  });
  // after an update: one toast (not on a first start, which has nothing unseen)
  if (config.onboarded && unseenReleaseNotes().length) toast({ kind: 'info', text: `Jaffer updated to ${app.version}`, actions: [{ label: "What's new", run: showWhatsNew }] });
  await Promise.all([refreshInfo(), loadClaudeState()]);
  void Promise.resolve(j.updates?.state?.()).then((s) => s && (updateState.value = s)).catch(() => undefined);
  ready.value = true;
}

let infoTimer: ReturnType<typeof setTimeout> | null = null;
let gitTimer: ReturnType<typeof setTimeout> | null = null;
function refreshInfoSoon(): void {
  if (infoTimer) clearTimeout(infoTimer);
  infoTimer = setTimeout(() => void refreshInfo(), 120);
}

export async function patchConfig(p: object): Promise<void> {
  const next = await jaffer().call('config.patch', p);
  cfg.value = next;
}

// ------------------------------------------------------------------ the side panel

/** Whether the side panel is open (`panel.open`, open by default). */
export const panelOpen = (): boolean => cfg.value?.panel?.open !== false;
/** A change to the panel: shown at once (a drag ends without a jump back, ⌘B twice is open again), then kept in the config. */
export function patchPanel(p: Partial<JafferConfig['panel']>): void {
  const c = cfg.value;
  if (!c) return;
  cfg.value = { ...c, panel: { ...c.panel, ...p } };
  void patchConfig({ panel: p }).catch(() => undefined);
}
/** ⌘B, the title bar's button, the palette, Settings. */
let lastPanelToggle = { at: 0, via: '' };
/** ⌘B reaches the window twice in the packaged app (the menu's accelerator and the key itself): a toggle from the other source within 250 ms is that same press. */
export const togglePanel = (via = 'other'): void => {
  const now = Date.now();
  if (via !== lastPanelToggle.via && now - lastPanelToggle.at < 250 && (via === 'key' || lastPanelToggle.via === 'key')) return;
  lastPanelToggle = { at: now, via };
  patchPanel({ open: !panelOpen() });
};
/** The past conversations the panel last read (`claude.history`: ids, folders, times, token costs), so it shows them at once when it opens again; null: never read. Memory only. */
export const historyItems = signal<Conversation[] | null>(null);
/** Bumped by ⇧⌘O: the panel's search takes the keyboard (once per bump, also when the bump opened the panel). */
export const panelFocusSearch = signal(0);
/** ⇧⌘O, the menu bar's All Past Conversations…: the panel opens (when closed) with its search focused. */
export function showConversations(): void {
  if (overlay.value === 'onboarding') return; // (first run has to be answered first)
  if (overlay.value !== 'find') overlay.value = null; // a dialog would sit over the search (it used to be replaced by the list)
  if (!panelOpen()) patchPanel({ open: true });
  panelFocusSearch.value++;
}
// ------------------------------------------------------------------ what is new

/** The release notes of versions the person has not dismissed yet (none until the window knows the config and the version). */
export function unseenReleaseNotes(): ReleaseNote[] {
  const c = cfg.value;
  const v = appVersion.value;
  return c && v ? unseenNotes(RELEASE_NOTES, effectiveSeen({ seenVersion: c.updates?.seenVersion, onboarded: c.onboarded }, v), v) : [];
}
/** The What's New card was asked for (Help menu, palette, the toast, the menu bar item): it shows even with nothing unseen. */
export const whatsNewOpen = signal(false);
/** The card lists every version instead of the unseen notes. */
export const whatsNewAll = signal(false);
/** Help → What's New…: the panel opens (when closed) with the card at its top (the unseen notes, else the history). */
export function showWhatsNew(): void {
  if (overlay.value === 'onboarding') return; // (first run has to be answered first)
  if (!panelOpen()) patchPanel({ open: true });
  whatsNewAll.value = unseenReleaseNotes().length === 0;
  whatsNewOpen.value = true;
}
/** Dismiss: the card goes, and this version's notes count as seen (`updates.seenVersion`). */
export function dismissWhatsNew(): void {
  whatsNewOpen.value = false;
  whatsNewAll.value = false;
  const c = cfg.value;
  const v = appVersion.value;
  if (!c || !v || c.updates?.seenVersion === v) return;
  cfg.value = { ...c, updates: { ...c.updates, seenVersion: v } };
  void patchConfig({ updates: { seenVersion: v } }).catch(() => undefined);
}

/** True while the panel's edge is dragged: the terminal keeps its size and fits once when it is let go (not a resize per pixel). */
export const layoutHold = signal(false);

// ------------------------------------------------------------------ small display helpers

/** A command as it may be shown in the UI: secrets redacted, sensitive commands hidden. Only its head is read (a command line is forgeable at any length). */
export function safeCommand(cmd: string): string {
  const head = cmd.slice(0, 4 * COMMAND_HEAD);
  return isSensitiveCommand(head) ? '(hidden)' : redactText(head);
}

export function homeDir(): string {
  return (window as unknown as { __home?: string }).__home ?? '';
}

/** `/Users/maya/code/api` → `~/code/api`. */
export function tildePath(p: string): string {
  return tildeOf(p, homeDir());
}

export { fmtAgo };

