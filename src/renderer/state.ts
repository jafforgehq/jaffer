import { batch, signal } from '@preact/signals';
import type { JafferConfig } from '../shared/config';
import type { AgentEvent, ThreadItem, UsageTotals } from '../core/agent/types';
import type { AgentStatus } from '../core/agent/runtime';
import type { PaneInfo } from '../core/session/host';
import type { MemoryStats, ReflectionResult } from '../core/memory/types';
import { Emitter } from '../shared/emitter';

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
  lastCommand?: { cmd: string; exit: number | null };
  version?: string;
  startedAt?: string;
}

export type Side = 'agent' | 'memory' | null;
export type Overlay = null | 'settings' | 'palette' | 'onboarding' | 'find';

export const cfg = signal<JafferConfig | null>(null);
export const daemonUp = signal(true);
export const ready = signal(false);
export const info = signal<SessionInfo>({ cwd: '' });
export const panes = signal<PaneInfo[]>([]);
export const activePane = signal('main');
export const side = signal<Side>((store.get('jaffer.side') as Side) ?? 'agent');
export const sideWidth = signal(Number(store.get('jaffer.sideWidth')) || 420);
export const overlay = signal<Overlay>(null);
export const windowFocused = signal(true);
export const appVersion = signal('');
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
  toasts.value = [...toasts.value.slice(-3), { ...t, id }];
  setTimeout(() => dismissToast(id), ttl);
}
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ------------------------------------------------------------------ agent

export type LiveItem = ThreadItem & { state?: 'running' | 'approval' | 'done'; risk?: string; reason?: string; callId?: string };

export const thread = signal<LiveItem[]>([]);
export const agentStatus = signal<AgentStatus | null>(null);
export const turn = signal<{ id: string; started: number; thinking: string; notice?: string } | null>(null);
export const agentUsage = signal<UsageTotals | null>(null);
export const keyReady = signal(true);

let liveAssistant: { id: string; text: string } | null = null;
let seq = 0;

export async function loadThread(): Promise<void> {
  const r = await jaffer().call('agent.thread', {});
  batch(() => {
    thread.value = r.items as LiveItem[];
    agentStatus.value = r.status;
    agentUsage.value = r.status.usage;
    keyReady.value = r.status.ready;
  });
}

export function applyAgentEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'turn_start':
      liveAssistant = null;
      turn.value = { id: e.turnId, started: Date.now(), thinking: '' };
      thread.value = [...thread.value, { kind: 'user', id: `u${++seq}-${e.turnId}`, text: e.text }];
      break;
    case 'text': {
      if (!liveAssistant) {
        liveAssistant = { id: `a${++seq}-${e.turnId}`, text: '' };
        thread.value = [...thread.value, { kind: 'assistant', id: liveAssistant.id, text: '' }];
      }
      liveAssistant.text += e.delta;
      const id = liveAssistant.id;
      const text = liveAssistant.text;
      thread.value = thread.value.map((i) => (i.id === id ? { ...i, text } : i));
      break;
    }
    case 'thinking':
      if (turn.value) turn.value = { ...turn.value, thinking: (turn.value.thinking + e.delta).slice(-4000) };
      break;
    case 'tool_call':
      liveAssistant = null; // text after a tool call starts a new bubble
      thread.value = [...thread.value, { kind: 'tool', id: e.callId, callId: e.callId, name: e.name, summary: e.summary, input: e.input, state: 'running' }];
      break;
    case 'approval_request':
      thread.value = thread.value.map((i) => (i.kind === 'tool' && i.id === e.callId ? { ...i, state: 'approval', risk: e.risk, reason: e.reason } : i));
      break;
    case 'tool_result':
      thread.value = thread.value.map((i) => (i.kind === 'tool' && i.id === e.callId ? { ...i, output: e.output, isError: e.isError, state: 'done' } : i));
      break;
    case 'usage':
      agentUsage.value = e.usage;
      break;
    case 'notice':
      if (turn.value) turn.value = { ...turn.value, notice: e.text };
      toast({ kind: e.level === 'warn' ? 'error' : 'info', text: e.text });
      break;
    case 'turn_end':
      liveAssistant = null;
      turn.value = null;
      if (e.error) toast({ kind: 'error', text: e.error }, 9000);
      // settle on what was actually persisted (drops live-only state, thinking, etc.)
      void loadThread().catch(() => undefined);
      break;
  }
}

export async function sendToAgent(text: string): Promise<void> {
  try {
    await jaffer().call('agent.send', { text });
  } catch (e) {
    toast({ kind: 'error', text: e instanceof Error ? e.message : String(e) }, 8000);
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
  if (e.type === 'learned' && e.items?.length) {
    const it = e.items[0]!;
    toast({ kind: 'learn', text: `Remembered: ${it.text}`, action: { label: 'Undo', run: () => void jaffer().call('memory.forget', { id: it.id }).then(() => refreshMemory()) } });
  } else if (e.type === 'reflection' && e.result && e.result.applied > 0 && e.result.mode !== 'consolidate') {
    const r = e.result;
    toast({ kind: 'learn', text: r.summary, action: { label: 'Undo', run: () => void jaffer().call('memory.revert', { runId: r.runId }).then(() => refreshMemory()) } }, 8000);
  }
}

// ------------------------------------------------------------------ pty bus (consumed by terminal views)

export const ptyBus = new Emitter<{ event: string; data: any }>();

// ------------------------------------------------------------------ bootstrap

export async function refreshInfo(): Promise<void> {
  try {
    const [i, p] = await Promise.all([jaffer().call('session.info', {}), jaffer().call('pane.list', {})]);
    batch(() => {
      info.value = { ...info.value, ...i };
      panes.value = p;
    });
  } catch {
    /* ignore */
  }
}

export async function refreshKeyStatus(): Promise<void> {
  try {
    keyReady.value = (await jaffer().call('secrets.status', {})).ready;
  } catch {
    /* ignore */
  }
}

export async function bootstrap(): Promise<void> {
  const j = jaffer();
  j.onEvent((event, data) => {
    if (event.startsWith('pty.')) {
      ptyBus.emit({ event, data });
      if (event === 'pty.command') {
        info.value = { ...info.value, lastCommand: { cmd: data.cmd, exit: data.exit } };
        void refreshInfoSoon();
      } else if (event === 'pty.cwd') {
        info.value = { ...info.value, cwd: data.cwd };
        void refreshInfoSoon();
      }
    } else if (event === 'agent.event') applyAgentEvent(data);
    else if (event === 'memory.event') onMemoryEvent(data);
    else if (event === 'config.changed') {
      cfg.value = data;
      void refreshKeyStatus();
    } else if (event === 'session.lifecycle') void refreshInfo();
    else if (event === 'daemon.down') daemonUp.value = false;
    else if (event === 'daemon.up') {
      daemonUp.value = true;
      void refreshInfo();
      void loadThread();
      refreshMemory(0);
      ptyBus.emit({ event: 'daemon.up', data: {} });
    }
  });
  j.onFocus((f) => (windowFocused.value = f));
  const [config, app] = await Promise.all([j.call('config.get', {}), j.appInfo()]);
  batch(() => {
    cfg.value = config;
    appVersion.value = app.version;
    overlay.value = config.onboarded ? null : 'onboarding';
  });
  await Promise.all([refreshInfo(), loadThread(), refreshKeyStatus()]);
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
