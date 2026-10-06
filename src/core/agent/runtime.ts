import type { ConfigStore } from '../../shared/config';
import type { JafferPaths } from '../../shared/paths';
import { Emitter, errMsg, nowIso, uid } from '../../shared/util';
import type { MemoryEngine } from '../memory/engine';
import { buildSystemPrompt, terminalContextBlock } from './prompt';
import { allowKeyForCommand, assessCommand, assessFileRead, assessFileWrite, type Assessment } from './permissions';
import { executeTool, resolvePath, TOOL_SPECS, toolSummary, type ToolEnv } from './tools';
import { estimateTokens, isTurnStart, stripThinking, Thread } from './thread';
import { costUsd } from './anthropic';
import { emptyUsage, type AgentEvent, type AgentProvider, type ContentBlock, type Decision, type Message, type UsageTotals } from './types';

export interface TerminalInfo {
  cwd: string;
  project?: string;
  branch?: string;
  lastCommand?: { cmd: string; exit: number | null };
  busy?: string | null;
}

export interface AgentDeps {
  paths: JafferPaths;
  config: ConfigStore;
  provider: () => AgentProvider | null;
  toolEnv: () => ToolEnv;
  terminal: () => TerminalInfo;
  memory: MemoryEngine;
  credentialsReady: () => boolean;
  clock?: () => number;
}

export interface AgentStatus {
  ready: boolean;
  busy: boolean;
  model: string;
  usage: UsageTotals;
  threadTokens: number;
  messages: number;
  pendingApprovals: { callId: string; name: string; summary: string; reason: string }[];
}

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

interface Pending {
  resolve: (d: Decision) => void;
  info: { callId: string; name: string; summary: string; reason: string };
}

export class AgentRuntime {
  readonly events = new Emitter<AgentEvent>();
  readonly thread: Thread;
  private system = buildSystemPrompt();
  private abort: AbortController | null = null;
  private _busy = false;
  private pending = new Map<string, Pending>();
  private total: UsageTotals = emptyUsage();
  private previousAssistantReply = false;

  constructor(private deps: AgentDeps) {
    this.thread = new Thread(deps.paths);
    this.previousAssistantReply = this.thread.messages.some((m) => m.role === 'assistant');
  }

  get busy(): boolean {
    return this._busy;
  }

  status(): AgentStatus {
    return {
      ready: this.deps.credentialsReady(),
      busy: this._busy,
      model: this.deps.config.get().agent.model,
      usage: { ...this.total },
      threadTokens: estimateTokens(this.thread.messages, this.system.length),
      messages: this.thread.messages.length,
      pendingApprovals: [...this.pending.values()].map((p) => p.info),
    };
  }

  /** Start a turn. Resolves immediately with its id; progress arrives as events. */
  send(text: string): { turnId: string } {
    if (this._busy) throw new Error('The agent is still working on the previous message. Wait or cancel it first.');
    const turnId = uid('turn');
    this._busy = true;
    void this.runTurn(turnId, text).finally(() => {
      this._busy = false;
    });
    return { turnId };
  }

  cancel(): void {
    this.abort?.abort();
    for (const p of this.pending.values()) p.resolve('deny');
  }

  approve(callId: string, decision: Decision): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }

  // ------------------------------------------------------------------ turn

  private emit(e: AgentEvent): void {
    this.events.emit(e);
  }

  private async runTurn(turnId: string, text: string): Promise<void> {
    const cfg = this.deps.config.get();
    const provider = this.deps.provider();
    this.emit({ type: 'turn_start', turnId, text });
    if (!provider || !this.deps.credentialsReady()) {
      this._busy = false;
      this.emit({ type: 'turn_end', turnId, stopReason: 'error', error: 'No Anthropic credentials. Add an API key in Jaffer → Settings (or set ANTHROPIC_API_KEY) and try again.' });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    const turnUsage = emptyUsage();
    const toolNames: string[] = [];
    let reply = '';
    let stopReason = 'end_turn';
    let error: string | undefined;
    const term = this.deps.terminal();

    try {
      await this.maybeCompact(provider, turnId);

      // Everything below is append-only: the history, system prompt and tool list never change in place.
      const blocks: ContentBlock[] = [];
      const ctx = this.freshContext(term.cwd, text);
      if (ctx) blocks.push({ type: 'text', text: `<jaffer-context>\n${ctx}\n</jaffer-context>` });
      blocks.push({ type: 'text', text: terminalContextBlock({ ...term, date: new Date(this.deps.clock?.() ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }) });
      blocks.push({ type: 'text', text });
      const userMsg: Message = { role: 'user', content: blocks };
      this.thread.push(userMsg);

      let retriedThinking = false;
      for (let round = 0; round < cfg.agent.maxToolRounds; round++) {
        if (abort.signal.aborted) throw new CancelledError();
        let resp;
        try {
          resp = await provider.stream(
            { model: cfg.agent.model, system: this.system, tools: TOOL_SPECS, messages: this.thread.messages, effort: cfg.agent.effort, maxTokens: 32_000, fallbacks: cfg.agent.refusalFallback },
            { onText: (d) => this.emit({ type: 'text', turnId, delta: d }), onThinking: (d) => this.emit({ type: 'thinking', turnId, delta: d }) },
            abort.signal,
          );
        } catch (e) {
          if (abort.signal.aborted) throw new CancelledError();
          // A thinking block bound to an older prefix is rejected by the API: drop them all and retry once.
          if (!retriedThinking && isThinkingBindingError(e)) {
            retriedThinking = true;
            this.thread.messages = stripThinking(this.thread.messages);
            this.emit({ type: 'notice', turnId, level: 'info', text: 'Refreshed earlier reasoning blocks and retried.' });
            round--;
            continue;
          }
          throw e;
        }

        const u = { ...resp.usage, costUsd: costUsd(resp.model || cfg.agent.model, resp.usage) };
        addUsage(turnUsage, u);
        addUsage(this.total, u);
        this.emit({ type: 'usage', turnId, usage: { ...this.total }, turn: { ...turnUsage } });

        const text_ = resp.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
        if (text_) reply += (reply ? '\n' : '') + text_;
        stopReason = resp.stopReason ?? 'end_turn';

        const toolUses = resp.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');

        if (stopReason === 'refusal') {
          this.emit({ type: 'notice', turnId, level: 'warn', text: `The model declined this request${resp.stopCategory ? ` (${resp.stopCategory})` : ''}.` });
          break;
        }
        if (stopReason === 'max_tokens' && toolUses.length > 0) {
          this.emit({ type: 'notice', turnId, level: 'warn', text: 'The response was cut off mid-action, so nothing was run. Try a smaller step.' });
          break;
        }

        this.thread.push({ role: 'assistant', content: resp.content });
        if (toolUses.length === 0) {
          if (stopReason === 'pause_turn') continue;
          break;
        }

        const results: ContentBlock[] = [];
        for (const tu of toolUses) {
          toolNames.push(tu.name);
          if (abort.signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Cancelled by the user.', is_error: true });
            continue;
          }
          results.push(await this.runTool(turnId, tu, abort.signal));
        }
        this.thread.push({ role: 'user', content: results });
        if (abort.signal.aborted) throw new CancelledError();
        if (round === cfg.agent.maxToolRounds - 1) {
          this.emit({ type: 'notice', turnId, level: 'warn', text: `Stopped after ${cfg.agent.maxToolRounds} tool rounds. Say "continue" to keep going.` });
          stopReason = 'max_rounds';
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        stopReason = 'cancelled';
        this.closeDanglingToolUse();
      } else {
        stopReason = 'error';
        error = friendlyError(e);
        this.closeDanglingToolUse();
      }
    } finally {
      this.abort = null;
      this.pending.clear();
      this.thread.settle();
    }

    // Learning: record the exchange for the memory engine.
    try {
      this.deps.memory.observeAgentTurn({ user: text, reply, tools: toolNames, cwd: term.cwd, project: term.project, error, previousAssistant: this.previousAssistantReply });
      this.previousAssistantReply = true;
    } catch {
      /* memory must never break the agent */
    }
    // Clear busy *before* announcing the end, so a listener may immediately send the next message.
    this._busy = false;
    this.emit({ type: 'turn_end', turnId, stopReason, error });
  }

  /** After an interruption, make sure every tool_use in history has a matching tool_result. */
  private closeDanglingToolUse(): void {
    const msgs = this.thread.messages;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && Array.isArray(last.content)) {
      const uses = (last.content as ContentBlock[]).filter((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>[];
      if (uses.length) this.thread.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Interrupted before this ran.', is_error: true })) });
    }
  }

  // ------------------------------------------------------------------ tools

  private assess(name: string, input: any): Assessment {
    const cfg = this.deps.config.get().agent;
    const cwd = this.deps.terminal().cwd;
    switch (name) {
      case 'run_command':
        return assessCommand(String(input?.command ?? ''), cfg.approvals, cfg.allow);
      case 'read_file':
        return assessFileRead(resolvePath(String(input?.path ?? ''), cwd));
      case 'list_dir':
      case 'search_files':
      case 'read_terminal':
      case 'recall':
        return { verdict: 'auto', risk: 'read', reason: 'read-only' };
      case 'write_file':
      case 'edit_file':
        return assessFileWrite(resolvePath(String(input?.path ?? ''), cwd), cfg.approvals, cfg.allow, name);
      case 'terminal_input':
        return { verdict: 'ask', risk: 'risky', reason: 'types into the program running in your terminal' };
      case 'remember':
      case 'forget':
        return { verdict: 'auto', risk: 'write', reason: 'updates your memory (visible and reversible in the Memory panel)' };
      default:
        return { verdict: 'deny', risk: 'risky', reason: `unknown tool ${name}` };
    }
  }

  private async runTool(turnId: string, tu: Extract<ContentBlock, { type: 'tool_use' }>, signal: AbortSignal): Promise<ContentBlock> {
    const input = tu.input as any;
    const summary = toolSummary(tu.name, input);
    this.emit({ type: 'tool_call', turnId, callId: tu.id, name: tu.name, input, summary });
    const a = this.assess(tu.name, input);
    const finish = (output: string, isError: boolean, ms = 0): ContentBlock => {
      this.emit({ type: 'tool_result', turnId, callId: tu.id, output, isError, ms });
      return { type: 'tool_result', tool_use_id: tu.id, content: output, is_error: isError };
    };
    if (a.verdict === 'deny') return finish(a.reason, true);
    if (a.verdict === 'ask') {
      const decision = await this.requestApproval(turnId, tu.id, tu.name, input, summary, a);
      if (decision === 'deny') return finish('The user declined this action. Do not retry it in another form; ask what they would prefer.', true);
      if (decision === 'allow-always') this.addAllowRule(tu.name, input);
    }
    const t0 = Date.now();
    const out = await executeTool(this.deps.toolEnv(), tu.name, input, signal);
    return finish(out.output, out.isError, Date.now() - t0);
  }

  private addAllowRule(name: string, input: any): void {
    const key = name === 'run_command' ? allowKeyForCommand(String(input?.command ?? '')) : name === 'write_file' || name === 'edit_file' ? `${name}:*` : null;
    if (!key) return;
    const cur = this.deps.config.get().agent.allow;
    if (!cur.includes(key)) this.deps.config.patch({ agent: { allow: [...cur, key] } });
  }

  private requestApproval(turnId: string, callId: string, name: string, input: unknown, summary: string, a: Assessment): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => settle('deny'), APPROVAL_TIMEOUT_MS);
      const settle = (d: Decision) => {
        clearTimeout(timer);
        this.pending.delete(callId);
        resolve(d);
      };
      this.pending.set(callId, { resolve: settle, info: { callId, name, summary, reason: a.reason } });
      this.emit({ type: 'approval_request', turnId, callId, name, input, summary, risk: a.risk, reason: a.reason });
    });
  }

  // ------------------------------------------------------------------ memory context

  /** Only memory the agent has not yet seen in this conversation (append-only, cache-friendly). */
  private freshContext(cwd: string, query: string): string {
    const mem = this.deps.memory;
    if (!mem.enabled) return '';
    const probe = mem.context({ cwd, query, budgetChars: 6000, notes: true });
    const fresh = {
      items: new Set(probe.itemIds.filter((id) => !this.thread.wasShown(id))),
      skills: new Set(probe.skillIds.filter((id) => !this.thread.wasShown(id))),
    };
    const first = this.thread.shownCount === 0;
    if (fresh.items.size === 0 && fresh.skills.size === 0 && !(first && probe.text)) return '';
    const built = first ? probe : mem.context({ cwd, query, budgetChars: 3000, only: fresh, notes: false });
    this.thread.markShown([...built.itemIds, ...built.skillIds]);
    if (!built.text) return '';
    return `${first ? 'What Jaffer has learned about this user and their work:' : 'Newly relevant memory:'}\n\n${built.text}`;
  }

  // ------------------------------------------------------------------ compaction

  async maybeCompact(provider: AgentProvider, turnId?: string, force = false): Promise<boolean> {
    const cfg = this.deps.config.get();
    const msgs = this.thread.messages;
    const tokens = estimateTokens(msgs, this.system.length);
    if (!force && tokens < cfg.agent.compactAtTokens) return false;
    // Keep the last few turns verbatim; summarise everything before the turn boundary.
    let cut = msgs.length;
    let turnsKept = 0;
    for (let i = msgs.length - 1; i >= 0 && turnsKept < 2; i--) {
      if (isTurnStart(msgs[i]!)) {
        cut = i;
        turnsKept++;
      }
    }
    if (cut <= 1 || cut >= msgs.length) return false;
    const older = msgs.slice(0, cut);
    const keep = stripThinking(msgs.slice(cut));
    const transcript = renderTranscript(older, this.thread.summary);
    let summary: string;
    try {
      summary = await provider.complete({
        model: cfg.memory.reflectorModel,
        system: 'You compact long agent/terminal conversations into a briefing so the work can continue seamlessly. Be concrete and dense; keep file paths, commands, decisions, user preferences, open TODOs and unresolved problems. Omit pleasantries and raw tool output. Output only the briefing in markdown, under 1500 words.',
        user: `Compact this conversation:\n\n${transcript}`,
        maxTokens: 4000,
      });
    } catch (e) {
      this.emit({ type: 'notice', turnId, level: 'warn', text: `Could not compact the conversation (${errMsg(e)}); continuing with full history.` });
      return false;
    }
    summary = summary.trim();
    if (!summary) return false;
    const stamp = nowIso().slice(0, 16).replace('T', ' ');
    const head: Message[] = [
      { role: 'user', content: `<session-summary>\nBriefing of the earlier part of this single long-running session (compacted ${stamp} UTC):\n\n${summary}\n</session-summary>` },
      { role: 'assistant', content: 'Understood — I have the briefing and will continue from here.' },
    ];
    this.thread.replace([...head, ...keep], summary);
    this.emit({ type: 'notice', turnId, level: 'info', text: `Compacted earlier conversation (${tokens.toLocaleString()} → ~${estimateTokens(this.thread.messages).toLocaleString()} tokens). Nothing is lost: memory and the briefing carry on.` });
    return true;
  }
}

class CancelledError extends Error {}

function addUsage(a: UsageTotals, b: Partial<UsageTotals> & { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.costUsd += b.costUsd ?? 0;
}

export function renderTranscript(messages: Message[], priorSummary: string): string {
  const out: string[] = [];
  if (priorSummary) out.push(`[Earlier briefing]\n${priorSummary}\n`);
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(`${m.role.toUpperCase()}: ${stripCtx(m.content)}`);
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text') {
        const t = stripCtx(b.text);
        if (t) out.push(`${m.role.toUpperCase()}: ${t}`);
      } else if (b.type === 'tool_use') out.push(`TOOL CALL ${b.name}: ${JSON.stringify(b.input).slice(0, 400)}`);
      else if (b.type === 'tool_result') out.push(`TOOL RESULT${b.is_error ? ' (error)' : ''}: ${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 500)}`);
    }
  }
  return out.join('\n');
}

function stripCtx(t: string): string {
  if (t.startsWith('<jaffer-context>') || t.startsWith('<terminal>')) return '';
  return t;
}

export function isThinkingBindingError(e: unknown): boolean {
  const msg = errMsg(e).toLowerCase();
  return /thinking/.test(msg) && /(signature|bound|binding|conversation|prefix|invalid)/.test(msg);
}

export function friendlyError(e: unknown): string {
  const msg = errMsg(e);
  const status = (e as { status?: number })?.status;
  if (status === 401 || /authentication|api key|credentials/i.test(msg)) return 'Anthropic rejected the credentials. Check your API key in Jaffer → Settings.';
  if (status === 429) return 'Rate limited by the API. Wait a moment and try again.';
  if (status === 529 || /overloaded/i.test(msg)) return 'The API is overloaded right now. Try again shortly.';
  if (/context|too long|prompt is too long/i.test(msg) && status === 400) return 'The conversation no longer fits the context window. Try /compact.';
  return msg;
}
