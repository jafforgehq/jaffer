import fs from 'node:fs';
import path from 'node:path';
import { AgentRuntime } from '../../src/core/agent/runtime';
import type { AgentEvent, AgentProvider, ContentBlock, ProviderRequest, ProviderResponse, StreamHandlers } from '../../src/core/agent/types';
import { runSubprocess, type ToolEnv } from '../../src/core/agent/tools';
import { makeEngine, type TestEnv } from './env';
import type { MemoryEngine } from '../../src/core/memory/engine';

export type Script = (req: ProviderRequest, n: number) => ProviderResponse | Promise<ProviderResponse>;

export class ScriptedProvider implements AgentProvider {
  requests: ProviderRequest[] = [];
  completions: { system: string; user: string }[] = [];
  constructor(
    private script: Script[],
    private summarizer: (user: string) => string = () => 'SUMMARY: user is building X; decisions: use pnpm.',
  ) {}
  async stream(req: ProviderRequest, h: StreamHandlers, signal: AbortSignal): Promise<ProviderResponse> {
    // snapshot: the runtime mutates its message array in place
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    const n = this.requests.length - 1;
    const step = this.script[Math.min(n, this.script.length - 1)]!;
    if (signal.aborted) throw new Error('aborted');
    const r = await step(req, n);
    for (const b of r.content) {
      if (b.type === 'text') h.onText(b.text);
      if (b.type === 'thinking') h.onThinking((b as { thinking: string }).thinking);
    }
    return r;
  }
  async complete(req: { system: string; user: string }): Promise<string> {
    this.completions.push(req);
    return this.summarizer(req.user);
  }
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
export const text = (t: string, stop = 'end_turn'): ProviderResponse => ({ content: [{ type: 'text', text: t }], stopReason: stop, usage, model: 'claude-sonnet-5-5' });
export const tools = (calls: { name: string; input: unknown; text?: string; thinking?: boolean }[], stop = 'tool_use'): ProviderResponse => ({
  content: [
    ...(calls.some((c) => c.thinking) ? ([{ type: 'thinking', thinking: 'let me think', signature: 'sig' }] as unknown as ContentBlock[]) : []),
    ...calls.flatMap((c, i): ContentBlock[] => [...(c.text ? [{ type: 'text', text: c.text } as ContentBlock] : []), { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 8)}${i}`, name: c.name, input: c.input as Record<string, unknown> }]),
  ],
  stopReason: stop,
  usage,
  model: 'claude-sonnet-5-5',
});

export function makeToolEnv(cwd: string, engine: MemoryEngine, over: Partial<ToolEnv> = {}): ToolEnv {
  return {
    cwd: () => cwd,
    runInSession: async (cmd, timeoutMs) => {
      const r = await runSubprocess(cmd, cwd, timeoutMs);
      return { cmd, exit: r.exit, output: r.output, durMs: r.durMs, timedOut: r.timedOut, cwd };
    },
    readScreen: () => '$ ',
    terminalState: () => ({ busy: null, alt: false, cwd }),
    typeIntoTerminal: () => undefined,
    recall: (q) => engine.recall(q, { cwd }).items.map((i) => `${i.id}: ${i.text}`).join('\n') || 'Nothing found.',
    remember: (t) => {
      const r = engine.remember(t, { source: 'agent' });
      return 'error' in r ? r.error : `Remembered (${r.item.id}).`;
    },
    forget: (q) => `forgot ${engine.forget(q).archived.length}`,
    projectRoot: () => cwd,
    runIn: 'session',
    ...over,
  };
}

export interface Rig {
  agent: AgentRuntime;
  engine: MemoryEngine;
  provider: ScriptedProvider;
  events: AgentEvent[];
  work: string;
  /** Resolve once the current turn ends. */
  done(): Promise<AgentEvent & { type: 'turn_end' }>;
  /** Auto-answer approval requests. */
  autoApprove(decision: 'allow' | 'allow-always' | 'deny'): void;
}

export function makeRig(env: TestEnv, script: Script[], opts: { ready?: boolean; toolOver?: Partial<ToolEnv>; summarizer?: (u: string) => string } = {}): Rig {
  const work = path.join(env.root, 'work');
  fs.mkdirSync(work, { recursive: true });
  env.config.patch({ onboarded: true });
  const engine = makeEngine(env);
  const provider = new ScriptedProvider(script, opts.summarizer);
  const agent = new AgentRuntime({
    paths: env.paths,
    config: env.config,
    provider: () => provider,
    toolEnv: () => makeToolEnv(work, engine, opts.toolOver),
    terminal: () => ({ cwd: work, project: work, branch: 'main' }),
    memory: engine,
    credentialsReady: () => opts.ready ?? true,
  });
  const events: AgentEvent[] = [];
  agent.events.on((e) => events.push(e));
  let approver: ((d: 'allow' | 'allow-always' | 'deny') => void) | null = null;
  agent.events.on((e) => {
    if (e.type === 'approval_request' && approver) {
      const a = approver;
      queueMicrotask(() => a && agent.approve(e.callId, (a as unknown as { d: 'allow' | 'allow-always' | 'deny' }).d));
    }
  });
  return {
    agent,
    engine,
    provider,
    events,
    work,
    done: () =>
      new Promise((resolve) => {
        const existing = events.find((e) => e.type === 'turn_end' && !consumed.has(e));
        if (existing) {
          consumed.add(existing);
          return resolve(existing as AgentEvent & { type: 'turn_end' });
        }
        const off = agent.events.on((e) => {
          if (e.type === 'turn_end') {
            off();
            consumed.add(e);
            resolve(e);
          }
        });
      }),
    autoApprove: (d) => {
      approver = Object.assign(() => undefined, { d }) as unknown as (d: 'allow' | 'allow-always' | 'deny') => void;
    },
  };
}
const consumed = new WeakSet<AgentEvent>();
