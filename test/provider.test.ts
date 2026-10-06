import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAnthropic } from './helpers/mock-anthropic';
import { AnthropicLlm, AnthropicProvider, costUsd } from '../src/core/agent/anthropic';
import { TOOL_SPECS } from '../src/core/agent/tools';
import { buildSystemPrompt } from '../src/core/agent/prompt';

const mock = new MockAnthropic();
let client: Anthropic;
beforeAll(async () => {
  const url = await mock.listen();
  client = new Anthropic({ apiKey: 'sk-ant-test-0000000000000000', baseURL: url, maxRetries: 0 });
});
afterAll(() => mock.close());

const baseReq = { model: 'claude-sonnet-5-5', system: buildSystemPrompt(), tools: TOOL_SPECS, messages: [{ role: 'user' as const, content: 'hi' }], effort: 'medium' as const, maxTokens: 4000, fallbacks: true };

describe('AnthropicProvider against a mock Messages API (real SDK, real streaming)', () => {
  it('streams text and thinking deltas and returns the assembled message and usage', async () => {
    mock.requests.length = 0;
    mock.queue({ kind: 'text', text: 'Hello, streaming world!', thinking: 'pondering' });
    const p = new AnthropicProvider(() => client);
    const text: string[] = [];
    const thinking: string[] = [];
    const r = await p.stream(baseReq, { onText: (d) => text.push(d), onThinking: (d) => thinking.push(d) }, new AbortController().signal);
    expect(text.join('')).toBe('Hello, streaming world!');
    expect(text.length).toBeGreaterThan(1); // really streamed in pieces
    expect(thinking.join('')).toBe('pondering');
    expect(r.stopReason).toBe('end_turn');
    expect(r.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(r.usage).toEqual({ input: 120, output: 33, cacheRead: 5, cacheWrite: 7 });
  });

  it('sends the documented request shape: beta fallbacks, adaptive thinking, effort, eager tool streaming, caching', async () => {
    const q = mock.requests.at(-1)!;
    expect(q.path).toContain('/v1/messages');
    expect(q.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(q.body.model).toBe('claude-sonnet-5-5');
    expect(q.body.stream).toBe(true);
    expect(q.body.fallbacks).toBe('default');
    expect(q.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(q.body.output_config).toEqual({ effort: 'medium' });
    expect(q.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(q.body.tools.length).toBe(TOOL_SPECS.length);
    expect(q.body.tools.every((t: any) => t.eager_input_streaming === true)).toBe(true);
    // none of the parameters removed on the current models may be sent
    for (const k of ['temperature', 'top_p', 'top_k']) expect(q.body).not.toHaveProperty(k);
  });

  it('omits the fallback beta when disabled', async () => {
    mock.queue({ kind: 'text', text: 'x' });
    const p = new AnthropicProvider(() => client);
    await p.stream({ ...baseReq, fallbacks: false }, { onText() {}, onThinking() {} }, new AbortController().signal);
    const q = mock.requests.at(-1)!;
    expect(q.headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    expect(q.body).not.toHaveProperty('fallbacks');
  });

  it('assembles streamed tool_use input JSON', async () => {
    mock.queue({ kind: 'tool', id: 'toolu_1', name: 'run_command', input: { command: 'ls -la "my dir"', timeout_seconds: 5 }, text: 'Listing…' });
    const p = new AnthropicProvider(() => client);
    const r = await p.stream(baseReq, { onText() {}, onThinking() {} }, new AbortController().signal);
    expect(r.stopReason).toBe('tool_use');
    const tu = r.content.find((b) => b.type === 'tool_use') as any;
    expect(tu.name).toBe('run_command');
    expect(tu.input).toEqual({ command: 'ls -la "my dir"', timeout_seconds: 5 });
  });

  it('reports refusals with their category', async () => {
    mock.queue({ kind: 'refusal' });
    const p = new AnthropicProvider(() => client);
    const r = await p.stream(baseReq, { onText() {}, onThinking() {} }, new AbortController().signal);
    expect(r.stopReason).toBe('refusal');
    expect(r.stopCategory).toBe('cyber');
  });

  it('surfaces auth errors as typed errors the runtime can translate', async () => {
    mock.queue({ kind: 'error', status: 401, message: 'invalid x-api-key' });
    const p = new AnthropicProvider(() => client);
    await expect(p.stream(baseReq, { onText() {}, onThinking() {} }, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  });

  it('aborts mid-stream when the signal fires', async () => {
    mock.queue({ kind: 'text', text: 'x'.repeat(100) });
    const p = new AnthropicProvider(() => client);
    const ac = new AbortController();
    ac.abort();
    await expect(p.stream(baseReq, { onText() {}, onThinking() {} }, ac.signal)).rejects.toBeTruthy();
  });

  it('completes one-shot text (used by compaction) and the memory reflector client', async () => {
    mock.reset().queue({ kind: 'text', text: 'briefing text' }, { kind: 'text', text: '{"ops":[]}' });
    const p = new AnthropicProvider(() => client);
    expect(await p.complete({ model: 'claude-haiku-4-5', system: 's', user: 'u', maxTokens: 100 })).toBe('briefing text');
    const llm = new AnthropicLlm(() => client, 'claude-haiku-4-5');
    expect(await llm.complete({ system: 's', user: 'u' })).toBe('{"ops":[]}');
    expect(mock.requests.at(-1)!.body.model).toBe('claude-haiku-4-5');
  });

  it('prices usage for known models', () => {
    expect(costUsd('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(12, 5);
    expect(costUsd('unknown-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});
