import type { ConfigStore } from '../../shared/config';
import { Emitter } from '../../shared/util';
import type { ClaudeCodeEngine } from './claude-engine';
import type { AgentRuntime, AgentStatus } from './runtime';
import type { AgentEvent, Decision, ThreadItem } from './types';

export type EngineKind = 'api' | 'claude-code';

/**
 * The agent panel has one conversation on screen but two possible engines behind it: your Anthropic API key
 * (`AgentRuntime`) or your Claude Code login (`ClaudeCodeEngine`). The hub picks one per message and presents
 * a single event stream, thread and status to the rest of the app.
 *
 * For now Jaffer runs on Claude subscriptions only: the API-key engine is switched off (`apiEnabled`, see
 * JAFFER_API_ENGINE in the daemon), and the hub always answers with Claude Code. Switched on, "auto" prefers the API
 * key when there is one (it was added on purpose) and otherwise uses Claude Code.
 */
export class AgentHub {
  readonly events = new Emitter<AgentEvent>();

  constructor(
    readonly api: AgentRuntime,
    readonly cli: ClaudeCodeEngine,
    private config: ConfigStore,
    private ready: { api: () => boolean; claudeCode: () => boolean; apiEnabled: () => boolean },
  ) {
    api.events.on((e) => this.events.emit(e));
    cli.events.on((e) => this.events.emit(e));
  }

  kind(): EngineKind {
    if (!this.ready.apiEnabled()) return 'claude-code';
    const e = this.config.get().agent.engine;
    if (e === 'api' || e === 'claude-code') return e;
    return this.ready.api() ? 'api' : this.ready.claudeCode() ? 'claude-code' : 'api';
  }

  private get active(): AgentRuntime | ClaudeCodeEngine {
    return this.kind() === 'claude-code' ? this.cli : this.api;
  }

  get busy(): boolean {
    return this.api.busy || this.cli.busy;
  }

  get thread(): { items(): ThreadItem[] } {
    return this.active.thread;
  }

  status(): AgentStatus {
    return { ...this.active.status(), engines: { api: this.ready.apiEnabled() && this.ready.api(), claudeCode: this.ready.claudeCode() } };
  }

  send(text: string): { turnId: string } {
    if (this.busy) throw new Error('The agent is still working on the previous message. Wait or cancel it first.');
    return this.active.send(text);
  }

  cancel(): void {
    this.api.cancel();
    this.cli.cancel();
  }

  approve(callId: string, decision: Decision): boolean {
    return this.api.approve(callId, decision) || this.cli.approve(callId, decision);
  }

  async dispose(): Promise<void> {
    this.api.cancel();
    await this.cli.dispose();
  }
}
