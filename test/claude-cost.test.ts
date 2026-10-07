import { describe, expect, it } from 'vitest';
import { formatTokens, formatUsd, priceOf, responseCost, summarizeLines } from '../src/shared/claude-cost';

const line = (id: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', requestId: `req_${id}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage }, ...extra });

describe('priceOf', () => {
  it('knows the models by id, dated snapshots and context suffixes', () => {
    expect(priceOf('claude-sonnet-5-5')?.input).toBe(2);
    expect(priceOf('claude-opus-5-5')?.output).toBe(20);
    expect(priceOf('claude-opus-5-5')?.cacheRead).toBe(0.2);
    expect(priceOf('claude-opus-5')?.input).toBe(5);
    expect(priceOf('claude-opus-4-5')?.input).toBe(5);
    expect(priceOf('claude-opus-4-1-20250805')?.input).toBe(15);
    expect(priceOf('claude-haiku-4-5-20251001')?.output).toBe(5);
    expect(priceOf('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(priceOf('claude-fable-5')?.cacheRead).toBe(1);
    expect(priceOf('claude-opus-5-5[1m]')?.input).toBe(4);
  });

  it('prices cache writes at 1.25x (five minutes) and 2x (an hour) the input price', () => {
    expect(priceOf('claude-haiku-4-5')).toMatchObject({ input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
  });

  it('gives no price to a model it does not know, rather than the nearest one', () => {
    expect(priceOf('claude-opus-5-6')).toBeUndefined(); // not claude-opus-5
    expect(priceOf('claude-sonnet-6')).toBeUndefined();
    expect(priceOf('gpt-5')).toBeUndefined();
    expect(priceOf('<synthetic>')).toBeUndefined();
    expect(priceOf(undefined)).toBeUndefined();
  });
});

describe('responseCost', () => {
  it('adds input, output, cache reads and both kinds of cache writes', () => {
    // (1000 × 2 + 2000 × 10 + 10000 × 0.2 + 5000 × 4) / 1e6
    expect(responseCost({ input: 1000, output: 2000, cacheRead: 10_000, cacheWrite5m: 0, cacheWrite1h: 5000 }, 'claude-sonnet-5-5')).toBeCloseTo(0.044, 6);
    expect(responseCost({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0 }, 'claude-haiku-4-5')).toBeCloseTo(1.25, 6);
  });

  it('doubles fast mode where the model has it, and adds 10% for US-only inference', () => {
    const t = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(responseCost(t, 'claude-opus-5-5')).toBeCloseTo(4, 6);
    expect(responseCost(t, 'claude-opus-5-5', { fast: true })).toBeCloseTo(8, 6);
    expect(responseCost(t, 'claude-opus-4-7', { fast: true })).toBeCloseTo(5, 6); // no fast mode there
    expect(responseCost(t, 'claude-sonnet-5-5', { us: true })).toBeCloseTo(2.2, 6);
  });

  it('has no cost without a price', () => {
    expect(responseCost({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'mystery')).toBeUndefined();
  });
});

describe('summarizeLines', () => {
  const u = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } };

  it('counts a response once even though every content block of it has a line', () => {
    const r = summarizeLines([line('m1', 'claude-sonnet-5-5', u), line('m1', 'claude-sonnet-5-5', u), line('m1', 'claude-sonnet-5-5', u)])!;
    expect(r.messages).toBe(1);
    expect(r).toMatchObject({ input: 10, output: 500, cacheRead: 40_000, cacheWrite: 2000, model: 'claude-sonnet-5-5' });
    // (10 × 2 + 500 × 10 + 40000 × 0.2 + 2000 × 4) / 1e6
    expect(r.usd).toBeCloseTo(0.02102, 6);
  });

  it('adds up the responses of a turn with tool calls', () => {
    const r = summarizeLines([line('m1', 'claude-sonnet-5-5', u), line('m2', 'claude-sonnet-5-5', { ...u, output_tokens: 100 })])!;
    expect(r.messages).toBe(2);
    expect(r.output).toBe(600);
    expect(r.cacheRead).toBe(80_000);
  });

  it('takes the largest count when an early line of a response was written before it was complete', () => {
    const r = summarizeLines([line('m1', 'claude-sonnet-5-5', { ...u, output_tokens: 3 }), line('m1', 'claude-sonnet-5-5', u)])!;
    expect(r.output).toBe(500);
  });

  it('prices cache writes without the 5m/1h split as the short kind', () => {
    const r = summarizeLines([line('m1', 'claude-haiku-4-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })])!;
    expect(r.usd).toBeCloseTo(1.25, 6);
  });

  it('keeps the tokens but gives no dollars when a model has no price', () => {
    const r = summarizeLines([line('m1', 'claude-sonnet-5-5', u), line('m2', 'claude-newest-9', u)])!;
    expect(r.usd).toBeUndefined();
    expect(r.messages).toBe(2);
    expect(r.output).toBe(1000);
  });

  it('skips Claude Code’s own synthetic messages, other entry types, broken lines and lines without usage', () => {
    const lines = [
      line('s1', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello "usage"' } }),
      '{not json "usage"',
      JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'claude-sonnet-5-5', content: [] } }),
      '',
    ];
    expect(summarizeLines(lines)).toBeUndefined();
  });

  it('names the model that did most of the work', () => {
    const r = summarizeLines([line('m1', 'claude-haiku-4-5-20251001', { input_tokens: 5, output_tokens: 5 }), line('m2', 'claude-opus-5-5', u)])!;
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.usd).toBeGreaterThan(0);
  });
});

describe('formatting', () => {
  it('shows dollars the way a person reads them', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.002)).toBe('<$0.01');
    expect(formatUsd(0.0449)).toBe('$0.04');
    expect(formatUsd(1.836)).toBe('$1.84');
    expect(formatUsd(123.4)).toBe('$123');
  });

  it('shortens token counts', () => {
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12_345)).toBe('12k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});
