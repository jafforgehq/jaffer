import { batch, signal } from '@preact/signals';
import type { JafferConfig } from '../shared/config';
import type { ClaudeSession } from '../core/claude/watcher';
import type { UpdateState } from '../shared/update-policy';
import { Emitter } from '../shared/emitter';
import { isSensitiveCommand, redactText } from '../shared/redact';
import { COMMAND_HEAD } from '../shared/process-badge';

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
}

export type Overlay = null | 'settings' | 'palette' | 'onboarding' | 'find' | 'recent';

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
export const appVersion = signal('');
/** Where the self-update stands (Settings → Updates). Null until the app answers. */
export const updateState = signal<UpdateState | null>(null);

// ------------------------------------------------------------------ terminal power (memory only: nothing here is written anywhere)

export interface RecentCommand {
  cmd: string;
  exit: number | null;
  at: number;
  durMs: number;
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

function remember(c: RecentCommand): void {
  if (!c.cmd.trim() || c.cmd.length > 4 * COMMAND_HEAD || isSensitiveCommand(c.cmd)) return;
  commands.value = [c, ...commands.value.filter((x) => x.cmd !== c.cmd)].slice(0, 200);
}

/** `4m 12s`, `45s`, `1h 3m`. */
export function fmtDuration(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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
}
export const toasts = signal<Toast[]>([]);
let toastId = 1;
/** Shows a toast for `ttl` ms (or until it is dismissed); returns its id, for `dismissToast`. */
export function toast(t: Omit<Toast, 'id'>, ttl = 6000): number {
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
const claudeLive = signal<ClaudeSession[]>([]);
/** The Claude session the mole and the title bar follow: the most recently changed one that has not ended. */
export const currentClaude = (): ClaudeSession | null => claudeLive.value.find((s) => s.state !== 'ended') ?? null;
async function loadClaudeState(): Promise<void> {
  try {
    claudeLive.value = (await jaffer().call('claude.state', {})).sessions;
  } catch {
    /* the daemon is not there yet; its next push fills this in */
  }
}

// ------------------------------------------------------------------ pty bus (consumed by terminal views)

export const ptyBus = new Emitter<{ event: string; data: any }>();

// ------------------------------------------------------------------ bootstrap

async function refreshInfo(): Promise<void> {
  try {
    const i = await jaffer().call('session.info', {});
    batch(() => {
      const { recentCommands: _recent, panes: _panes, ...rest } = i as SessionInfo & { panes?: unknown; recentCommands?: unknown };
      info.value = { ...info.value, project: undefined, branch: undefined, ...rest }; // (the answer leaves out what there is none of: outside a repository there is no branch, not the last one)
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
        if (data.pane === 'main') {
          info.value = { ...info.value, busy: data.cmd || 'command', busySince: Date.now() };
          port.value = null;
        }
        void refreshInfoSoon();
      } else if (event === 'pty.command') {
        info.value = { ...info.value, busy: null, busySince: null };
        if (data.pane === 'main') {
          port.value = null;
          remember({ cmd: String(data.cmd ?? ''), exit: data.exit ?? null, at: Date.now(), durMs: Number(data.durMs) || 0 });
          if (Number(data.durMs) >= 30_000 && !windowFocused.value) away = [{ cmd: String(data.cmd ?? ''), exit: data.exit ?? null, durMs: Number(data.durMs) }, ...away].slice(0, 50);
        }
        void refreshInfoSoon();
      } else if (event === 'pty.cwd') {
        info.value = { ...info.value, cwd: data.cwd };
        void refreshInfoSoon();
      }
    } else if (event === 'claude.state') claudeLive.value = data.sessions;
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
  const [config, app] = await Promise.all([j.call('config.get', {}), j.appInfo()]);
  batch(() => {
    cfg.value = config;
    appVersion.value = app.version;
    overlay.value = config.onboarded ? null : 'onboarding';
  });
  await Promise.all([refreshInfo(), loadClaudeState()]);
  void Promise.resolve(j.updates?.state?.()).then((s) => s && (updateState.value = s)).catch(() => undefined);
  ready.value = true;
}

let infoTimer: ReturnType<typeof setTimeout> | null = null;
function refreshInfoSoon(): void {
  if (infoTimer) clearTimeout(infoTimer);
  infoTimer = setTimeout(() => void refreshInfo(), 120);
}

export async function patchConfig(p: object): Promise<void> {
  const next = await jaffer().call('config.patch', p);
  cfg.value = next;
}

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
  const home = homeDir();
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

export function fmtAgo(ts: number | string, now = Date.now()): string {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

