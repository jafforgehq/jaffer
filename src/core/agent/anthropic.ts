import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../memory/llm';
import type { AgentProvider, ProviderRequest, ProviderResponse, StreamHandlers, ContentBlock } from './types';

export type CredentialSource = 'secret-store' | 'env' | 'none';

export interface Credentials {
  apiKey?: string;
  source: CredentialSource;
}

export function resolveCredentials(stored: string | null, env: NodeJS.ProcessEnv = process.env): Credentials {
  if (stored) return { apiKey: stored, source: 'secret-store' };
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY, source: 'env' };
  return { source: 'none' };
}

export function makeClient(c: Credentials): Anthropic {
  // With no explicit key the SDK still resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  return c.apiKey ? new Anthropic({ apiKey: c.apiKey, maxRetries: 3 }) : new Anthropic({ maxRetries: 3 });
}

/** Messages API provider: streaming, adaptive thinking, eager tool-input streaming, refusal fallback. */
export class AnthropicProvider implements AgentProvider {
  constructor(private getClient: () => Anthropic) {}

  async stream(req: ProviderRequest, h: StreamHandlers, signal: AbortSignal): Promise<ProviderResponse> {
    const client = this.getClient();
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system }],
      tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })),
      messages: req.messages,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: req.effort },
      // Cache everything up to the last block automatically: the thread grows append-only, so each turn re-reads it cheaply.
      cache_control: { type: 'ephemeral' },
    };
    const betas: string[] = [];
    if (req.fallbacks) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    if (betas.length) params.betas = betas;
    const stream = client.beta.messages.stream(params as unknown as Anthropic.Beta.MessageCreateParamsStreaming & { stream?: never }, { signal });
    stream.on('streamEvent', (e) => {
      if (e.type === 'content_block_delta') {
        if (e.delta.type === 'text_delta') h.onText(e.delta.text);
        else if (e.delta.type === 'thinking_delta') h.onThinking(e.delta.thinking);
      }
    });
    const msg = await stream.finalMessage();
    const u = msg.usage;
    return {
      content: msg.content as unknown as ContentBlock[],
      stopReason: msg.stop_reason,
      stopCategory: (msg as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? null,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      model: msg.model,
    };
  }

  async complete(req: { model: string; system: string; user: string; maxTokens: number }): Promise<string> {
    const client = this.getClient();
    const msg = await client.messages.create({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] });
    return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

/** Text completion for the memory reflector (cheap model, no tools, no thinking). */
export class AnthropicLlm implements LlmClient {
  constructor(
    private getClient: () => Anthropic,
    private defaultModel: string,
  ) {}
  async complete(req: { system: string; user: string; maxTokens?: number; model?: string }): Promise<string> {
    const msg = await this.getClient().messages.create({ model: req.model ?? this.defaultModel, max_tokens: req.maxTokens ?? 2000, system: req.system, messages: [{ role: 'user', content: req.user }] });
    return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

/** Per-million-token prices (USD) for cost display. Unknown models cost nothing in the UI. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function costUsd(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ''];
  if (!p) return 0;
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}
