import type Anthropic from '@anthropic-ai/sdk';

export type Message = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export type Risk = 'read' | 'write' | 'command' | 'risky';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties?: boolean };
}

export type AgentEvent =
  | { type: 'turn_start'; turnId: string; text: string }
  | { type: 'text'; turnId: string; delta: string }
  | { type: 'thinking'; turnId: string; delta: string }
  | { type: 'tool_call'; turnId: string; callId: string; name: string; input: unknown; summary: string }
  | { type: 'approval_request'; turnId: string; callId: string; name: string; input: unknown; summary: string; risk: Risk; reason: string }
  | { type: 'tool_result'; turnId: string; callId: string; output: string; isError: boolean; ms: number }
  | { type: 'usage'; turnId: string; usage: UsageTotals; turn: UsageTotals }
  | { type: 'notice'; turnId?: string; level: 'info' | 'warn'; text: string }
  | { type: 'turn_end'; turnId: string; stopReason: string; error?: string };

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

export type Decision = 'allow' | 'allow-always' | 'deny';

/** What the UI renders for a persisted thread. */
export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'summary'; id: string; text: string };

export interface ProviderRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: Message[];
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  fallbacks: boolean;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: string | null;
  stopCategory?: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model: string;
}

export interface StreamHandlers {
  onText(delta: string): void;
  onThinking(delta: string): void;
}

export interface AgentProvider {
  stream(req: ProviderRequest, h: StreamHandlers, signal: AbortSignal): Promise<ProviderResponse>;
  /** One-shot text completion (used for compaction). */
  complete(req: { model: string; system: string; user: string; maxTokens: number }): Promise<string>;
}
