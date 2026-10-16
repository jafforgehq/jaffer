import { Emitter } from '../../shared/emitter';
import { redactText } from '../../shared/redact';
import { isSensitivePath } from '../../shared/sensitive-path';
import { toolCategory, type ToolCategory } from '../../shared/tool-category';
import type { TurnCost } from '../../shared/claude-cost';
import { isPaneId } from '../../shared/session-id';

/**
 * What the Claude Code running in Jaffer's terminal is doing, built from its hook events. Pure state: no I/O, so it is
 * tested with captured payloads. Hooks are async and can arrive out of order, so only the events that start work
 * (UserPromptSubmit, PreToolUse) move a session to `working`; late "done" events only complete their own entry.
 */

export type ClaudeState = 'idle' | 'working' | 'needs-you' | 'ended';
/** `tool`: the name of the last tool the agent called (a hook from inside it carries its `agent_id`). */
export interface ClaudeSubagent { id: string; status: 'running' | 'done'; startedAt: number; tool?: string }
/** One tool call of the turn: its name and kind, when it ran, whether it failed, and the background agent that made it. Never its arguments. */
export interface ToolCall { name: string; category: ToolCategory; startedAt: number; endedAt?: number; failed?: boolean; agentId?: string }
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
/**
 * What the rest of Jaffer may know about a Claude Code session: whether it works, waits or is done, its background agents, the
 * names, kinds, timings and failures of its tool calls, the paths of the files it edits or writes (redacted, never a sensitive one,
 * in memory only), what its answers cost and which of Jaffer's terminals it runs in. Nothing else the person wrote or Claude answered is
 * kept, not even redacted (no prompts, replies, commands, folders or other tool arguments): nothing shows it, so nothing holds it.
 */
export interface ClaudeSession {
  id: string;
  /** The terminal it runs in (`main`, `p2`..`p4`: a short plain id the hook CLI adds from the shell's `JAFFER_PANE`); the latest heard. */
  pane?: string;
  state: ClaudeState;
  since: number;
  /** When the session was first heard of. */
  startedAt: number;
  /** How many prompts the person sent (Claude Code's own task notifications are not prompts). */
  turns: number;
  /** Claude Code is compacting its context (PreCompact), until the session starts again, a prompt, a tool call, Stop or SessionEnd. */
  compacting?: boolean;
  /** The tool calls since the last prompt (the last 200); they stay after Stop until the next prompt. */
  calls: ToolCall[];
  /** How many calls of each kind since the last prompt (all of them, also those `calls` let go). */
  counts: Record<string, number>;
  /** The file the running Edit, Write, MultiEdit or NotebookEdit writes, redacted, never a sensitive one. */
  file?: string;
  /** The files those tools changed since the last prompt (the same rules, each once, at most 50). */
  files: string[];
  /** When the current turn began: a session leaving idle for working. Going to needs-you and back is the same turn. */
  turnStartedAt?: number;
  /** The turn went idle without finishing: the person stopped it (Esc, a declined prompt), or it went quiet for minutes (an API error, a crash). */
  cutShort?: boolean;
  /** The tool call Claude is running or asking about: its name and id, never its arguments. */
  tool?: { name: string; id: string };
  /** Claude Code's own words for what it waits for ("Claude needs your permission to use Bash"), redacted. */
  notice?: string;
  subagents: ClaudeSubagent[];
  cost?: ClaudeCost;
  /**
   * While the session works: what the answer has cost so far, read by the daemon from the transcript (`input` is every token read in,
   * new and cached; `usd` only for a model with a known price) and when it last changed. Kept while Claude waits for the person; gone at
   * Stop and at the next prompt.
   */
  live?: { input: number; output: number; usd?: number; at: number };
}
/** The daemon's own view: where the transcript lives, and the ids that pair a call with its result, are for the daemon only and never go out with the state. */
export interface TrackedSession extends ClaudeSession {
  transcriptPath?: string;
  calls: (ToolCall & { id?: string })[];
}

const MAX_SUBAGENTS = 20;
const MAX_CALLS = 200;
const MAX_FILES = 50;
/** Longer is no path on a Mac (PATH_MAX is 1024): dropped, not cut, since a cut path names another file. */
const MAX_PATH = 1024;
/** The tools whose `tool_input.file_path` (NotebookEdit: `notebook_path`) is kept: the ones that write a file. */
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_SESSIONS = 5;
const ENDED_TTL_MS = 5 * 60_000;
/** A turn that is `working` but has gone this quiet (no hook, transcript not growing) is over: Esc and API errors fire no Stop hook. */
const STALE_MS = 5 * 60_000;
/** With a tool running there is nothing to hear for as long as the tool takes (a build), so be patient. */
const STALE_TOOL_MS = 30 * 60_000;
const MAX_NOTICE = 200;
/**
 * A SessionStart this soon after its session ended is that run's own start arriving late (hooks are async: `claude -p` that fails at
 * once ends before its start is heard), not a new run, unless Claude Code says the session goes on (`CONTINUES`).
 */
const LATE_START_MS = 3_000;
/** SessionStart sources that continue a session that just ended: resumed (`--resume`, `--continue`), cleared, compacted. */
const CONTINUES = new Set(['resume', 'clear', 'compact']);
const KNOWN = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'PreCompact']);

/** Redact first (on a bounded slice, so a huge field stays cheap), then collapse whitespace and cut. */
function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = redactText(v.slice(0, 20_000)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The file a writing tool call writes, as it may be kept: redacted, never a sensitive one, never cut. Any other call: none. */
function writtenPath(o: Record<string, unknown>): string | undefined {
  if (!WRITES.has(str(o.tool_name)) || !o.tool_input || typeof o.tool_input !== 'object') return undefined;
  const input = o.tool_input as Record<string, unknown>;
  const p = str(input.file_path) || str(input.notebook_path);
  return p && p.length <= MAX_PATH && !isSensitivePath(p) ? redactText(p) : undefined;
}

interface Entry { s: TrackedSession; touched: number }

export class ClaudeWatcher {
  readonly changes = new Emitter<TrackedSession[]>();
  /** A turn Claude finished itself (Stop; not one cut short): how long it took, in ms. */
  readonly finished = new Emitter<number>();
  private map = new Map<string, Entry>();
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

  /** A terminal's shell or its `claude` ended: its sessions are over, and so are those whose terminal is not known (an older hook). */
  endPane(pane: string): void {
    const before = JSON.stringify(this.snapshot());
    for (const { s } of this.map.values()) if (s.state !== 'ended' && (s.pane === undefined || s.pane === pane)) this.end(s);
    if (JSON.stringify(this.snapshot()) !== before) this.changes.emit(this.sessions());
  }

  /**
   * The user typed in the terminal while Claude waited for them: they are answering. Back to working, tool kept (an approval
   * is followed by PostToolUse; a decline fires no hook and is noticed from the transcript, see interrupted). With `pane`, only the
   * sessions of the terminal typed in (and those whose terminal is not known).
   */
  userAnswered(pane?: string): void {
    const before = JSON.stringify(this.snapshot());
    for (const { s } of this.map.values()) {
      if (s.state !== 'needs-you' || (pane !== undefined && s.pane !== undefined && s.pane !== pane)) continue;
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
    this.setState(e.s, 'idle');
    e.s.cutShort = true;
    e.s.notice = undefined;
    e.s.tool = undefined;
    e.s.file = undefined;
    e.s.compacting = undefined;
    e.s.live = undefined;
    this.closeCalls(e.s);
    this.changes.emit(this.sessions());
  }

  /**
   * Safety net for a turn that ended without any signal (a crash, an API error, an interruption the transcript did not show):
   * `working` with no hook for minutes, and `alive` (is the transcript still growing?) saying no, becomes idle. `needs-you` is
   * never swept: waiting for a person takes as long as it takes.
   */
  sweep(alive: (s: TrackedSession) => boolean): void {
    const t = this.now();
    let changed = false;
    for (const e of this.map.values()) {
      const s = e.s;
      const quiet = t - e.touched;
      if (s.state === 'working' && quiet >= (s.tool ? STALE_TOOL_MS : STALE_MS) && !alive({ ...s })) {
        this.setState(s, 'idle');
        s.cutShort = true;
        s.tool = undefined;
        s.file = undefined;
        s.compacting = undefined;
        s.live = undefined;
        this.closeCalls(s);
        changed = true;
      }
      // a compaction that failed says nothing either (a `/compact` while idle: no SessionStart follows)
      if (s.compacting && quiet >= STALE_MS && !alive({ ...s })) {
        s.compacting = undefined;
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

  /** The daemon read what the answer being written has cost so far. Only for a session that works, and said only when it changed. */
  setLive(sessionId: string, so: { input: number; output: number; usd?: number }): void {
    const s = this.map.get(sessionId)?.s;
    if (!s || s.state !== 'working') return;
    if (s.live && s.live.input === so.input && s.live.output === so.output && s.live.usd === so.usd) return;
    s.live = { input: so.input, output: so.output, ...(so.usd !== undefined ? { usd: so.usd } : {}), at: this.now() };
    this.changes.emit(this.sessions());
  }

  /** Newest change first; ended sessions older than five minutes are dropped. For the daemon itself: the transcript path is in it. */
  sessions(): TrackedSession[] {
    const t = this.now();
    for (const [id, { s }] of this.map) if (s.state === 'ended' && t - s.since > ENDED_TTL_MS) this.map.delete(id);
    return this.snapshot();
  }

  /** What may leave the daemon (to the window, over RPC): the same sessions without the transcript's path and the calls' ids. */
  view(): ClaudeSession[] {
    return this.sessions().map(({ transcriptPath: _file, calls, ...rest }) => ({ ...rest, calls: calls.map(({ id: _id, ...c }) => c) }));
  }

  private snapshot(): TrackedSession[] {
    return [...this.map.values()]
      .sort((a, b) => b.touched - a.touched)
      .map(({ s }) => ({ ...s, tool: s.tool && { ...s.tool }, cost: s.cost && { ...s.cost, last: { ...s.cost.last } }, live: s.live && { ...s.live }, subagents: s.subagents.map((a) => ({ ...a })), calls: s.calls.map((c) => ({ ...c })), counts: { ...s.counts }, files: [...s.files] }));
  }

  /** The turn is over: a call with no result yet (Esc, a result that never came) ends now. */
  private closeCalls(s: ClaudeSession): void {
    for (const c of s.calls) c.endedAt ??= this.now();
  }

  private setState(s: ClaudeSession, state: ClaudeState): void {
    if (s.state !== state) {
      if (state === 'working' && s.state !== 'needs-you') {
        s.turnStartedAt = this.now();
        s.cutShort = undefined;
      }
      s.state = state;
      s.since = this.now();
    }
  }

  private end(s: ClaudeSession): void {
    for (const a of s.subagents) a.status = 'done';
    this.setState(s, 'ended');
    s.tool = undefined;
    s.file = undefined;
    s.notice = undefined;
    s.compacting = undefined;
    s.live = undefined;
    this.closeCalls(s);
  }

  private session(id: string): TrackedSession {
    const hit = this.map.get(id);
    if (hit) {
      hit.touched = this.now();
      return hit.s;
    }
    if (this.map.size >= MAX_SESSIONS) {
      const victim = [...this.map.entries()].sort((a, b) => Number(b[1].s.state === 'ended') - Number(a[1].s.state === 'ended') || a[1].touched - b[1].touched)[0];
      if (victim) this.map.delete(victim[0]);
    }
    const s: TrackedSession = { id, state: 'idle', since: this.now(), startedAt: this.now(), turns: 0, calls: [], counts: {}, files: [], subagents: [] };
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
    // ...except a SessionStart that is the ended run's own start, arriving late: it would leave an idle session nothing ever sweeps
    if (ev === 'SessionStart' && prior?.state === 'ended' && this.now() - prior.since < LATE_START_MS && !CONTINUES.has(str(o.source))) return;
    const stayEnded = prior?.state === 'ended' && ev !== 'SessionStart';
    const endedSince = prior?.since ?? 0;
    if (stayEnded && (ev === 'UserPromptSubmit' || ev === 'PreToolUse' || ev === 'Notification' || ev === 'PreCompact')) return; // things that start something cannot be late

    const s = this.session(id);
    if (str(o.transcript_path)) s.transcriptPath = str(o.transcript_path).slice(0, 400);
    if (isPaneId(o.jaffer_pane)) s.pane = o.jaffer_pane;

    switch (ev) {
      case 'SessionStart':
        if (str(o.source) === 'compact') s.compacting = undefined; // the compacted session starts again (also in the middle of a turn)
        // A new or resumed session is idle. But `claude "<prompt>"` and `claude -p` fire SessionStart and UserPromptSubmit a moment
        // apart, both async: a SessionStart that lands after the prompt must not take a working (or waiting) session back to idle.
        if (s.state === 'working' || s.state === 'needs-you') break;
        this.setState(s, 'idle');
        s.tool = undefined;
        s.file = undefined;
        s.notice = undefined;
        break;
      case 'UserPromptSubmit':
        this.setState(s, 'working');
        s.notice = undefined;
        s.compacting = undefined;
        s.live = undefined; // a new answer: it is measured from this prompt
        s.subagents = s.subagents.filter((a) => a.status === 'running');
        // a new turn: its calls and files start over (those of the last one stayed readable until now)
        s.turns++;
        s.calls = [];
        s.counts = {};
        s.files = [];
        break;
      case 'PreToolUse': {
        this.setState(s, 'working');
        s.notice = undefined;
        s.compacting = undefined;
        const name = clip(o.tool_name, 60);
        const callId = str(o.tool_use_id).slice(0, 80);
        // a call made inside a background agent carries its id: the call is that agent's, and so is its last tool
        const agentId = clip(o.agent_id, 60) || undefined;
        s.tool = { name, id: callId };
        s.file = writtenPath(o);
        const category = toolCategory(name);
        s.calls.push({ name, category, startedAt: this.now(), id: callId || undefined, agentId });
        if (s.calls.length > MAX_CALLS) s.calls.splice(0, s.calls.length - MAX_CALLS);
        s.counts[category] = (s.counts[category] ?? 0) + 1;
        const agent = agentId && s.subagents.find((a) => a.id === agentId);
        if (agent) agent.tool = name;
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        // calls can overlap: a late result of an earlier call must not clear the tool of a later one (without ids, it does)
        const finished = str(o.tool_use_id).slice(0, 80);
        if (s.tool && (!finished || !s.tool.id || s.tool.id === finished)) {
          s.tool = undefined;
          s.file = undefined;
        }
        // the call it ends: the one with its id, or (an older Claude Code sends none) the latest still open; one already ended stays as it was
        const call = finished ? s.calls.findLast((c) => c.id === finished) : s.calls.findLast((c) => c.endedAt === undefined);
        if (call && call.endedAt === undefined) {
          call.endedAt = this.now();
          if (ev === 'PostToolUseFailure') call.failed = true;
        }
        const written = ev === 'PostToolUse' ? writtenPath(o) : undefined;
        if (written && !s.files.includes(written) && s.files.length < MAX_FILES) s.files.push(written);
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
          s.subagents.push({ id: agentId, status, startedAt: this.now() });
          if (s.subagents.length > MAX_SUBAGENTS) s.subagents.splice(0, s.subagents.length - MAX_SUBAGENTS);
        }
        break;
      }
      case 'Stop':
        if ((s.state === 'working' || s.state === 'needs-you') && s.turnStartedAt !== undefined) this.finished.emit(this.now() - s.turnStartedAt);
        this.setState(s, 'idle');
        s.tool = undefined;
        s.file = undefined;
        s.notice = undefined;
        s.compacting = undefined;
        s.live = undefined;
        this.closeCalls(s);
        break;
      case 'SessionEnd':
        this.end(s);
        break;
      case 'PreCompact':
        s.compacting = true;
        break;
    }
    if (stayEnded) {
      s.state = 'ended';
      s.since = endedSince;
      s.tool = undefined;
      s.file = undefined;
      s.notice = undefined;
    }
  }
}
