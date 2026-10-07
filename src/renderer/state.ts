import { batch, signal } from '@preact/signals';
import type { JafferConfig } from '../shared/config';
import type { ClaudeSession } from '../core/claude/watcher';
import { memoryToast } from '../shared/memory-toast';
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
export const windowFocused = signal(true);
export const appVersion = signal('');
/** Where the self-update stands (Settings → Updates). Null until the app answers. */
export const updateState = signal<UpdateState | null>(null);
export const zoom = signal(0);

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
export function toast(t: Omit<Toast, 'id'>, ttl = 6000): void {
  const id = toastId++;
  // memory notices replace each other instead of piling up over the terminal
  toasts.value = [...toasts.value.filter((x) => !(t.kind === 'learn' && x.kind === 'learn')).slice(-3), { ...t, id }];
  setTimeout(() => dismissToast(id), ttl);
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
export function applyClaudeState(sessions: ClaudeSession[]): void {
  claudeLive.value = sessions;
}
async function loadClaudeState(): Promise<void> {
  try {
    applyClaudeState((await jaffer().call('claude.state', {})).sessions);
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

export async function refreshInfo(): Promise<void> {
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
    else if (event === 'update.state') updateState.value = data;
    else if (event === 'memory.event') onMemoryEvent(data);
    else if (event === 'config.changed') cfg.value = data;
    else if (event === 'session.lifecycle') void refreshInfo();
    else if (event === 'daemon.down') daemonUp.value = false;
    else if (event === 'daemon.up') {
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

