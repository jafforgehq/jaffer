import { Emitter } from '../../shared/emitter';
import { isSensitiveCommand, redactText } from '../../shared/redact';
import type { TurnCost } from '../../shared/claude-cost';

/**
 * What the Claude Code running in Jaffer's terminal is doing, built from its hook events. Pure state: no I/O, so it is
 * tested with captured payloads. Hooks are async and can arrive out of order, so only the events that start work
 * (UserPromptSubmit, PreToolUse) move a session to `working`; late "done" events only complete their own entry.
 */

export type ClaudeState = 'idle' | 'working' | 'needs-you' | 'ended';
export interface ClaudeActivity { id: string; name: string; summary: string; status: 'running' | 'done' | 'failed'; startedAt: number; durMs?: number }
export interface ClaudeSubagent { id: string; type: string; status: 'running' | 'done'; startedAt: number }
/** What the answers of one session cost, estimated from their token counts (see shared/claude-cost). */
export interface ClaudeCost {
  last: TurnCost;
  /** Dollars over the answers that could be priced. */
  totalUsd: number;
  answers: number;
  /** Some answer had no known price, so the total is a floor. */
  partial: boolean;
  at: number;
}
export interface ClaudeSession {
  id: string;
  cwd: string;
  model?: string;
  state: ClaudeState;
  since: number;
  prompt?: string;
  tool?: { name: string; summary: string };
  activity: ClaudeActivity[];
  subagents: ClaudeSubagent[];
  lastReply?: string;
  notice?: string;
  transcriptPath?: string;
  cost?: ClaudeCost;
}

const MAX_ACTIVITY = 30;
const MAX_SUBAGENTS = 20;
const MAX_SESSIONS = 5;
const ENDED_TTL_MS = 5 * 60_000;
/** A turn that is `working` but has gone this quiet (no hook, transcript not growing) is over: Esc and API errors fire no Stop hook. */
const STALE_MS = 5 * 60_000;
/** With a tool running there is nothing to hear for as long as the tool takes (a build), so be patient. */
const STALE_TOOL_MS = 30 * 60_000;
const MAX_PROMPT = 120;
const MAX_REPLY = 240;
const MAX_SUMMARY = 160;
const MAX_NOTICE = 200;
const KNOWN = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']);

/** Redact first (on a bounded slice, so a huge field stays cheap), then collapse whitespace and cut. */
function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = redactText(v.slice(0, 20_000)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The one field of a tool call that says what it is doing (raw: callers redact). */
export function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  switch (name) {
    case 'Bash':
      return str(i.command);
    case 'Edit':
    case 'Write':
    case 'Read':
      return str(i.file_path);
    case 'NotebookEdit':
      return str(i.notebook_path) || str(i.file_path);
    case 'Agent':
    case 'Task':
      return str(i.description);
    case 'Grep':
    case 'Glob':
      return str(i.pattern);
    default:
      return '';
  }
}

function safeSummary(name: string, input: unknown): string {
  const raw = summarizeTool(name, input);
  if (name === 'Bash' && isSensitiveCommand(raw)) return '';
  return clip(raw, MAX_SUMMARY);
}

interface Entry { s: ClaudeSession; touched: number }

export class ClaudeWatcher {
  readonly changes = new Emitter<ClaudeSession[]>();
  private map = new Map<string, Entry>();
  private seq = 0;
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** One hook payload. Never throws; anything unexpected is ignored. */
  handle(payload: unknown): void {
    const before = JSON.stringify(this.snapshot());
    try {
      this.apply(payload);
    } catch {
      /* a malformed payload must never break the daemon */
    }
    if (JSON.stringify(this.snapshot()) !== before) this.changes.emit(this.sessions());
  }

  endAll(): void {
    const before = JSON.stringify(this.snapshot());
    for (const { s } of this.map.values()) if (s.state !== 'ended') this.end(s);
    if (JSON.stringify(this.snapshot()) !== before) this.changes.emit(this.sessions());
  }

  /**
   * The user typed in the terminal while Claude waited for them: they are answering. Back to working, tool kept (an approval
   * is followed by PostToolUse; a decline fires no hook and is noticed from the transcript, see interrupted).
   */
  userAnswered(): void {
    const before = JSON.stringify(this.snapshot());
    for (const { s } of this.map.values()) {
      if (s.state !== 'needs-you') continue;
      this.setState(s, 'working');
      s.notice = undefined;
    }
    if (JSON.stringify(this.snapshot()) !== before) this.changes.emit(this.sessions());
  }

  /**
   * The person stopped Claude in the terminal (declined a prompt, or pressed Esc). Neither fires a hook, least of all Stop, so the
   * daemon reads it from the transcript and calls this: back to idle, whatever was running did not finish.
   */
  interrupted(sessionId: string): void {
    const e = this.map.get(sessionId);
    if (!e || !(e.s.state === 'working' || e.s.state === 'needs-you')) return;
    this.settle(e.s, 'failed');
    this.setState(e.s, 'idle');
    e.s.notice = undefined;
    e.s.tool = undefined;
    this.changes.emit(this.sessions());
  }

  /**
   * Safety net for a turn that ended without any signal (a crash, an API error, an interruption the transcript did not show):
   * `working` with no hook for minutes, and `alive` (is the transcript still growing?) saying no, becomes idle. `needs-you` is
   * never swept: waiting for a person takes as long as it takes.
   */
  sweep(alive: (s: ClaudeSession) => boolean): void {
    const t = this.now();
    let changed = false;
    for (const e of this.map.values()) {
      const s = e.s;
      const quiet = t - e.touched;
      if (s.state === 'working' && quiet >= (s.tool ? STALE_TOOL_MS : STALE_MS) && !alive({ ...s })) {
        this.settle(s, 'failed');
        this.setState(s, 'idle');
        s.tool = undefined;
        changed = true;
      }
      // a background agent outlives the turn that started it, so only long silence (no hook, transcript not growing) ends it
      if (s.state !== 'ended' && quiet >= STALE_TOOL_MS && s.subagents.some((a) => a.status === 'running') && !alive({ ...s })) {
        for (const a of s.subagents) a.status = 'done';
        changed = true;
      }
    }
    if (changed) this.changes.emit(this.sessions());
  }

  /** The daemon read what the answer that just ended cost. Pure bookkeeping: the number comes from the transcript. */
  setCost(sessionId: string, turn: TurnCost): void {
    const e = this.map.get(sessionId);
    if (!e) return;
    const prev = e.s.cost;
    e.s.cost = { last: turn, totalUsd: (prev?.totalUsd ?? 0) + (turn.usd ?? 0), answers: (prev?.answers ?? 0) + 1, partial: (prev?.partial ?? false) || turn.usd === undefined, at: this.now() };
    this.changes.emit(this.sessions());
  }

  /** Rows still `running` when the turn is over (their PostToolUse never came) are finished one way or the other. */
  private settle(s: ClaudeSession, as: 'done' | 'failed'): void {
    for (const a of s.activity) if (a.status === 'running') a.status = as;
  }

  /** Newest change first; ended sessions older than five minutes are dropped. */
  sessions(): ClaudeSession[] {
    const t = this.now();
    for (const [id, { s }] of this.map) if (s.state === 'ended' && t - s.since > ENDED_TTL_MS) this.map.delete(id);
    return this.snapshot();
  }

  private snapshot(): ClaudeSession[] {
    return [...this.map.values()]
      .sort((a, b) => b.touched - a.touched)
      .map(({ s }) => ({ ...s, tool: s.tool && { ...s.tool }, cost: s.cost && { ...s.cost, last: { ...s.cost.last } }, activity: s.activity.map((a) => ({ ...a })), subagents: s.subagents.map((a) => ({ ...a })) }));
  }

  private setState(s: ClaudeSession, state: ClaudeState): void {
    if (s.state !== state) {
      s.state = state;
      s.since = this.now();
    }
  }

  private end(s: ClaudeSession): void {
    for (const a of s.subagents) a.status = 'done';
    this.setState(s, 'ended');
    s.tool = undefined;
    s.notice = undefined;
  }

  private session(id: string, cwd: string): ClaudeSession {
    const hit = this.map.get(id);
    if (hit) {
      hit.touched = this.now();
      return hit.s;
    }
    if (this.map.size >= MAX_SESSIONS) {
      const victim = [...this.map.entries()].sort((a, b) => Number(b[1].s.state === 'ended') - Number(a[1].s.state === 'ended') || a[1].touched - b[1].touched)[0];
      if (victim) this.map.delete(victim[0]);
    }
    const s: ClaudeSession = { id, cwd, state: 'idle', since: this.now(), activity: [], subagents: [] };
    this.map.set(id, { s, touched: this.now() });
    return s;
  }

  private apply(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const o = payload as Record<string, unknown>;
    const ev = str(o.hook_event_name);
    const id = str(o.session_id).slice(0, 80);
    if (!id || !KNOWN.has(ev)) return;
    if (ev === 'UserPromptSubmit' && str(o.prompt).trimStart().startsWith('<task-notification>')) return; // Claude Code's own background notices

    // Hooks are async: some are still in flight when the session ends or the shell sees `claude` exit. They may still
    // record what happened (the last reply, a finished tool), but only a SessionStart (a resumed session) brings an
    // ended session back to life.
    const prior = this.map.get(id)?.s;
    const stayEnded = prior?.state === 'ended' && ev !== 'SessionStart';
    const endedSince = prior?.since ?? 0;
    if (stayEnded && (ev === 'UserPromptSubmit' || ev === 'PreToolUse' || ev === 'Notification')) return; // things that start something cannot be late

    const s = this.session(id, clip(o.cwd, 300));
    if (str(o.cwd) && !s.cwd) s.cwd = clip(o.cwd, 300);
    if (str(o.transcript_path)) s.transcriptPath = str(o.transcript_path).slice(0, 400);

    switch (ev) {
      case 'SessionStart':
        s.model = clip(o.model, 80) || s.model;
        this.setState(s, 'idle');
        s.tool = undefined;
        s.notice = undefined;
        break;
      case 'UserPromptSubmit':
        this.setState(s, 'working');
        s.prompt = clip(o.prompt, MAX_PROMPT);
        s.notice = undefined;
        s.activity = [];
        s.subagents = s.subagents.filter((a) => a.status === 'running');
        break;
      case 'PreToolUse': {
        const name = clip(o.tool_name, 60);
        const summary = safeSummary(name, o.tool_input);
        this.setState(s, 'working');
        s.notice = undefined;
        s.tool = { name, summary };
        s.activity.push({ id: str(o.tool_use_id) || `t${++this.seq}`, name, summary, status: 'running', startedAt: this.now() });
        if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const entry = s.activity.find((a) => a.id === str(o.tool_use_id)) ?? [...s.activity].reverse().find((a) => a.status === 'running' && a.name === str(o.tool_name));
        if (entry) {
          entry.status = ev === 'PostToolUse' ? 'done' : 'failed';
          if (typeof o.duration_ms === 'number' && Number.isFinite(o.duration_ms)) entry.durMs = Math.max(0, Math.round(o.duration_ms));
        }
        if (s.tool && (!entry || s.tool.name === entry.name)) s.tool = undefined;
        s.notice = undefined;
        if (s.state === 'needs-you') this.setState(s, 'working'); // answered; never idle → working (see the note on ordering above)
        break;
      }
      case 'Notification': {
        const type = str(o.notification_type);
        const message = clip(o.message, MAX_NOTICE);
        const permission = type === 'permission_prompt' || (type !== 'idle_prompt' && /permission/i.test(message));
        if (permission && s.tool && s.state !== 'ended') {
          this.setState(s, 'needs-you');
          s.notice = message;
        }
        break;
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        const agentId = clip(o.agent_id, 60);
        if (!agentId) break;
        const status = ev === 'SubagentStart' ? 'running' : 'done';
        const hit = s.subagents.find((a) => a.id === agentId);
        if (hit) {
          if (status === 'running' && hit.status !== 'running') hit.startedAt = this.now(); // the same id working again is a new run
          hit.status = status;
        } else {
          s.subagents.push({ id: agentId, type: clip(o.agent_type, 60) || 'agent', status, startedAt: this.now() });
          if (s.subagents.length > MAX_SUBAGENTS) s.subagents.splice(0, s.subagents.length - MAX_SUBAGENTS);
        }
        break;
      }
      case 'Stop':
        this.settle(s, 'done');
        this.setState(s, 'idle');
        s.tool = undefined;
        s.notice = undefined;
        s.lastReply = clip(o.last_assistant_message, MAX_REPLY) || s.lastReply;
        break;
      case 'SessionEnd':
        this.end(s);
        break;
    }
    if (stayEnded) {
      s.state = 'ended';
      s.since = endedSince;
      s.tool = undefined;
      s.notice = undefined;
    }
  }
}
