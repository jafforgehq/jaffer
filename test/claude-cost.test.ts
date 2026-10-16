import { describe, expect, it } from 'vitest';
import { contextWindow, dayTotal, formatTokens, formatUsd, priceOf, responseCost, summarizeLines, summarizeTurn, usageByTime } from '../src/shared/claude-cost';

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

describe('dayTotal: what the answers finished today cost (the daily budget is measured against it)', () => {
  const at = (h: number, m: number, s = 0, day = 13) => new Date(2026, 9, day, h, m, s).getTime(); // local time, as the person's clock

  it('adds up the answers of the local day, and starts again at local midnight', () => {
    let today = dayTotal(undefined, at(9, 0));
    expect(today).toEqual({ usd: 0, date: '2026-10-13' });
    today = dayTotal(today, at(9, 5), 0.25);
    today = dayTotal(today, at(23, 59, 59), 0.5);
    expect(today).toEqual({ usd: 0.75, date: '2026-10-13' });
    expect(dayTotal(today, at(0, 0, 1, 14))).toEqual({ usd: 0, date: '2026-10-14' }); // a new day, before any answer of it
    expect(dayTotal(today, at(0, 0, 1, 14), 0.1)).toEqual({ usd: 0.1, date: '2026-10-14' });
  });

  it('pads the date, so the first of a month reads as the person expects', () => {
    expect(dayTotal(undefined, new Date(2027, 0, 1, 12, 0).getTime()).date).toBe('2027-01-01');
  });
});

describe('dayTotal.workMs: the time of the turns finished today (Claude worked ...)', () => {
  const at = (h: number, m: number, s = 0, day = 13) => new Date(2026, 9, day, h, m, s).getTime();

  it('adds the turns of the local day, ignores one under a second, and starts again at local midnight with the cost', () => {
    let today = dayTotal(undefined, at(9, 0));
    expect(today.workMs ?? 0).toBe(0);
    today = dayTotal(today, at(9, 5), 0.25, 60_000);
    today = dayTotal(today, at(9, 6), 0, 999); // under a second: not a turn worth counting
    today = dayTotal(today, at(9, 7), 0.5, 1000);
    expect(today).toEqual({ usd: 0.75, date: '2026-10-13', workMs: 61_000 });
    expect(dayTotal(today, at(9, 8)).workMs).toBe(61_000); // a read of it changes nothing
    expect(dayTotal(today, at(0, 0, 1, 14))).toEqual({ usd: 0, date: '2026-10-14' }); // (no time, no key: the totals of before stay as they were)
    expect(dayTotal(today, at(0, 0, 1, 14), 0.1, 5_000)).toEqual({ usd: 0.1, date: '2026-10-14', workMs: 5_000 });
  });

  it('takes nothing odd as a time', () => {
    const t = dayTotal(undefined, at(9, 0), 0, 2000);
    expect(dayTotal(t, at(9, 1), 0, Number.NaN).workMs).toBe(2000);
    expect(dayTotal(t, at(9, 1), 0, -5000).workMs).toBe(2000);
    expect(dayTotal(t, at(9, 1), 0, Infinity).workMs).toBe(2000);
  });
});

describe('contextWindow (1.4.0): how many tokens a model can hold, by its id (checked against the docs of 2026-10-16)', () => {
  it('1M for the families with a million-token window, also dated snapshots and the [1m] suffix', () => {
    for (const m of ['claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-7', 'claude-opus-4-8-20260101', 'claude-opus-4-9', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-sonnet-4-6[1m]', 'claude-opus-5-5[1m]']) expect(contextWindow(m), m).toBe(1_000_000);
  });

  it('200k for the other Claude models, none for an id it cannot read', () => {
    for (const m of ['claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4', 'claude-opus-4-20250514', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-3-5', 'claude-opus-6']) expect(contextWindow(m), m).toBe(200_000);
    for (const m of ['', '<synthetic>', 'gpt-5', 'claude', 'opus', undefined as never, 42 as never]) expect(contextWindow(m), String(m)).toBeUndefined();
  });
});

describe('summarizeTurn (1.4.0): the cost and the context of the latest response, in one pass', () => {
  it('the context is what the latest response read in (new, cache written, cache read; never its output), with its model', () => {
    const r = summarizeTurn([line('m1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 900, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }), line('m2', 'claude-opus-5-5', { input_tokens: 7, output_tokens: 50, cache_read_input_tokens: 120_000, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 2000 } })]);
    expect(r.context).toEqual({ tokens: 7 + 120_000 + 300 + 2000, model: 'claude-opus-5-5' });
    expect(r.cost).toEqual(summarizeLines([line('m1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 900, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }), line('m2', 'claude-opus-5-5', { input_tokens: 7, output_tokens: 50, cache_read_input_tokens: 120_000, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 2000 } })]));
  });

  it('a response written in several lines counts its largest numbers; synthetic messages and other lines are no context; none without a response', () => {
    const r = summarizeTurn([line('m1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 10 }), line('m1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 400 }), line('s1', '<synthetic>', { input_tokens: 0, output_tokens: 0 }), JSON.stringify({ type: 'user', message: { role: 'user', content: 'q "usage"' } })]);
    expect(r.context).toEqual({ tokens: 405, model: 'claude-sonnet-5-5' });
    expect(summarizeTurn(['', '{bad "usage"'])).toEqual({});
  });

  it('a subagent\'s line (isSidechain) counts for the cost but is not the main conversation\'s context', () => {
    const r = summarizeTurn([line('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90_000 }), line('m2', 'claude-haiku-4-5', { input_tokens: 500, output_tokens: 1 }, { isSidechain: true })]);
    expect(r.context).toEqual({ tokens: 90_010, model: 'claude-opus-5-5' });
    expect(r.cost!.messages).toBe(2);
    expect(summarizeTurn([line('m2', 'claude-haiku-4-5', { input_tokens: 500, output_tokens: 1 }, { isSidechain: true })]).context).toBeUndefined();
  });
});

describe('usageByTime (1.4.0): each response once, with when it was written, for the last 5 hours', () => {
  it('one entry per response: its time (the latest of its lines), all its tokens, its price when the model has one', () => {
    const u = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000 };
    const out = usageByTime([
      line('m1', 'claude-sonnet-5-5', u, { timestamp: '2026-10-16T10:00:00.000Z' }),
      line('m1', 'claude-sonnet-5-5', u, { timestamp: '2026-10-16T10:00:01.000Z' }),
      line('m2', 'claude-newest-9', u, { timestamp: '2026-10-16T11:00:00.000Z' }),
      line('m3', 'claude-sonnet-5-5', u), // no time: not placed
      line('m4', 'claude-sonnet-5-5', u, { timestamp: 'yesterday' }),
    ]);
    expect(out).toEqual([
      { id: 'm1', at: Date.parse('2026-10-16T10:00:01.000Z'), tokens: 42_510, usd: expect.closeTo((10 * 2 + 500 * 10 + 40_000 * 0.2 + 2000 * 2.5) / 1e6, 9) },
      { id: 'm2', at: Date.parse('2026-10-16T11:00:00.000Z'), tokens: 42_510 },
    ]);
  });
});
