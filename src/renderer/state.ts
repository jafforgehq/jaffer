import type { ResumeOffer } from '../shared/claude-resume';
import { batch, signal } from '@preact/signals';
import type { JafferConfig } from '../shared/config';
import type { ClaudeSession } from '../core/claude/watcher';
import { memoryToast } from '../shared/memory-toast';
import { TWO_RUNNING_NOTICE, TwoRunningNotice } from '../shared/one-claude';
import type { UpdateState } from '../shared/update-policy';
import type { MemoryStats, ReflectionResult } from '../core/memory/types';
import { Emitter } from '../shared/emitter';
import { isSensitiveCommand, redactText } from '../shared/redact';

const jaffer = () => window.jaffer;
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode etc. */
    }
  },
};

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

export type Side = 'memory' | null;
export type Overlay = null | 'settings' | 'palette' | 'onboarding' | 'find';

export const cfg = signal<JafferConfig | null>(null);
export const daemonUp = signal(true);
export const ready = signal(false);
export const info = signal<SessionInfo>({ cwd: '' });
export const activePane = signal('main');
/** A slow clock for relative times ("2m ago") without a timer per component. */
export const clock = signal(Date.now());
setInterval(() => (clock.value = Date.now()), 15_000);
export const side = signal<Side>(store.get('jaffer.side') === 'memory' ? 'memory' : null); // the memory drawer; closed unless the person opened it
export const sideWidth = signal(Number(store.get('jaffer.sideWidth')) || 420);
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

export function setSide(s: Side): void {
  side.value = s;
  store.set('jaffer.side', s ?? '');
}
export function toggleSide(s: Exclude<Side, null>): void {
  setSide(side.value === s ? null : s);
}
export function setSideWidth(w: number): void {
  sideWidth.value = Math.max(300, Math.min(760, Math.round(w)));
  store.set('jaffer.sideWidth', String(sideWidth.value));
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  kind: 'learn' | 'info' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}
export const toasts = signal<Toast[]>([]);
let toastId = 1;
/** Shows a toast for `ttl` ms (or until it is dismissed); returns its id, for `dismissToast`. */
export function toast(t: Omit<Toast, 'id'>, ttl = 6000): number {
  const id = toastId++;
  // memory notices replace each other instead of piling up over the terminal
  toasts.value = [...toasts.value.filter((x) => !(t.kind === 'learn' && x.kind === 'learn')).slice(-3), { ...t, id }];
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
/**
 * Two Claude conversations running: each set is told once while this window lives, and only when it is still running a moment later
 * (`/clear` looks like two for an instant). Only words: nothing is ended, the person decides what to do with the second one.
 */
const twoRunningNotice = new TwoRunningNotice({
  tell: () => void toast({ kind: 'info', text: TWO_RUNNING_NOTICE }),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});
/** Every way the window learns what Claude is doing (a pushed event, the answer when the window starts or the daemon comes back) comes through here. */
function applyClaudeState(sessions: ClaudeSession[]): void {
  claudeLive.value = sessions;
  twoRunningNotice.update(sessions);
}
/** Claude Code was running in this folder when Jaffer last stopped, and can be resumed (the daemon decides; null when there is nothing to offer). */
export const resumeOffer = signal<ResumeOffer | null>(null);
/** The notice before the daemon types `claude --resume` by itself: one at a time, with Cancel, until it types, drops it or gives up. */
let autoResumeToast: number | null = null;
/** Counts what the daemon said about it, so an answer to `claude.autoresume.state` that a newer event overtook is not shown. */
let autoResumeSeen = 0;
function onAutoResume(e: { state?: string; typesAt?: number } | null): void {
  autoResumeSeen++;
  if (autoResumeToast !== null) dismissToast(autoResumeToast);
  autoResumeToast = null;
  if (e?.state !== 'pending' || typeof e.typesAt !== 'number') return;
  const left = Math.max(0, e.typesAt - Date.now());
  const s = Math.max(1, Math.ceil(left / 1000)); // a notice that reached the window late is still "in 1 s", never "in 0 s"
  const when = s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  // up for as long as the wait (a retry waits minutes), a little past it: the daemon's next word takes it away
  autoResumeToast = toast({ kind: 'info', text: `Resuming Claude in ${when}`, action: { label: 'Cancel', run: () => void jaffer().call('claude.autoresume.cancel', {}).catch(() => undefined) } }, Math.max(6000, left + 2000));
}
async function loadClaudeState(): Promise<void> {
  try {
    applyClaudeState((await jaffer().call('claude.state', {})).sessions);
    resumeOffer.value = (await jaffer().call('claude.resume', {})) ?? null;
    // a notice announced before this window was listening (it opened after a reboot, or reconnected after an update)
    const seen = autoResumeSeen;
    const notice = await jaffer().call('claude.autoresume.state', {});
    if (notice && seen === autoResumeSeen) onAutoResume(notice);
  } catch {
    /* the daemon is not there yet; its next push fills this in */
  }
}

// ------------------------------------------------------------------ memory

export interface MemItemView {
  id: string;
  kind: string;
  scope: string;
  text: string;
  confidence: number;
  evidence: number;
  uses: number;
  pinned: boolean;
  status: string;
  source: string;
  updatedAt: string;
  lastSeenAt: string;
}
export interface SkillView {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  steps: string[];
  scope: string;
  confidence: number;
  evidence: number;
  uses: number;
  pinned: boolean;
}
export interface LogRun {
  runId: string;
  ts: string;
  source: string;
  sources: string[];
  reason?: string;
  ops: { op: string; id: string; text?: string }[];
}

export const memItems = signal<MemItemView[]>([]);
export const memSkills = signal<SkillView[]>([]);
export const memStats = signal<MemoryStats | null>(null);
export const memLog = signal<LogRun[]>([]);
export const memPulse = signal(0); // bumps whenever memory changes, drives the "evolving" indicator

let memTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshMemory(delay = 150): void {
  if (memTimer) clearTimeout(memTimer);
  memTimer = setTimeout(async () => {
    try {
      const [list, stats, log] = await Promise.all([jaffer().call('memory.list', {}), jaffer().call('memory.stats', {}), jaffer().call('memory.log', { limit: 300 })]);
      batch(() => {
        memItems.value = list.items;
        memSkills.value = list.skills;
        memStats.value = stats;
        memLog.value = log.runs;
      });
    } catch {
      /* daemon restarting */
    }
  }, delay);
}

function onMemoryEvent(e: { type: string; result?: ReflectionResult; items?: MemItemView[]; reason?: string }): void {
  memPulse.value++;
  refreshMemory();
  const t = memoryToast(e as Parameters<typeof memoryToast>[0]);
  if (!t) return; // housekeeping stays in the Memory drawer's Activity log
  const undo = t.undo;
  toast({ kind: 'learn', text: t.text, action: { label: 'Undo', run: () => void jaffer().call(undo.kind === 'forget' ? 'memory.forget' : 'memory.revert', undo.kind === 'forget' ? { id: undo.id } : { runId: undo.runId }).then(() => refreshMemory()) } }, 8000);
}

// ------------------------------------------------------------------ pty bus (consumed by terminal views)

export const ptyBus = new Emitter<{ event: string; data: any }>();

// ------------------------------------------------------------------ bootstrap

async function refreshInfo(): Promise<void> {
  try {
    const i = await jaffer().call('session.info', {});
    batch(() => {
      const { recentCommands: _recent, panes: _panes, ...rest } = i as SessionInfo & { panes?: unknown; recentCommands?: unknown };
      info.value = { ...info.value, ...rest };
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
        if (data.pane === 'main') info.value = { ...info.value, busy: data.cmd || 'command', busySince: Date.now() };
        void refreshInfoSoon();
      } else if (event === 'pty.command') {
        info.value = { ...info.value, busy: null, busySince: null };
        void refreshInfoSoon();
      } else if (event === 'pty.cwd') {
        info.value = { ...info.value, cwd: data.cwd };
        void refreshInfoSoon();
      }
    } else if (event === 'claude.state') applyClaudeState(data.sessions);
    else if (event === 'claude.resume') resumeOffer.value = data ?? null;
    else if (event === 'claude.autoresume') onAutoResume(data);
    else if (event === 'update.state') updateState.value = data;
    else if (event === 'memory.event') onMemoryEvent(data);
    else if (event === 'config.changed') cfg.value = data;
    else if (event === 'session.lifecycle') void refreshInfo();
    else if (event === 'daemon.down') {
      daemonUp.value = false;
      onAutoResume(null); // a daemon that is gone types nothing
    } else if (event === 'daemon.up') {
      daemonUp.value = true;
      void refreshInfo();
      void loadClaudeState();
      refreshMemory(0);
      ptyBus.emit({ event: 'daemon.up', data: {} });
    }
  });
  j.onFocus((f) => {
    windowFocused.value = f;
  });
  const [config, app] = await Promise.all([j.call('config.get', {}), j.appInfo()]);
  batch(() => {
    cfg.value = config;
    appVersion.value = app.version;
    overlay.value = config.onboarded ? null : 'onboarding';
  });
  await Promise.all([refreshInfo(), loadClaudeState()]);
  void Promise.resolve(j.updates?.state?.()).then((s) => s && (updateState.value = s)).catch(() => undefined);
  refreshMemory(0);
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

/** A command as it may be shown in the UI: secrets redacted, sensitive commands hidden. */
export function safeCommand(cmd: string): string {
  return isSensitiveCommand(cmd) ? '(hidden)' : redactText(cmd);
}

function homeDir(): string {
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

