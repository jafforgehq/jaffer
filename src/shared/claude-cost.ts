/**
 * What an answer from Claude Code cost, estimated from the token counts Claude Code writes into its own transcript and
 * Anthropic's published API list prices. It is an estimate in dollars of what those tokens are worth, not a bill: on a Claude
 * subscription nothing is charged per token. Pure: no I/O (the daemon reads the file, see `core/claude/cost.ts`).
 *
 * A model this table does not know gets no dollar figure at all (the tokens are still counted) rather than a guess.
 */

/** Dollars per million tokens. `fast` is the multiplier of fast mode, where the model has one. */
export interface Price {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  fast?: number;
}

const p = (input: number, output: number, cacheRead: number = input / 10, fast?: number): Price => ({ input, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead, output, fast });

/** https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-07). Keys are model ids without a date. */
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-mythos-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50),
  'claude-mythos-5': p(10, 50),
  'claude-opus-5-5': p(4, 20, 0.2, 2),
  'claude-opus-5': p(5, 25, undefined, 2),
  'claude-opus-4-8': p(5, 25, undefined, 2),
  'claude-opus-4-7': p(5, 25),
  'claude-opus-4-6': p(5, 25),
  'claude-opus-4-5': p(5, 25),
  'claude-opus-4-1': p(15, 75),
  'claude-opus-4': p(15, 75),
  'claude-sonnet-5-5': p(2, 10),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4-6': p(3, 15),
  'claude-sonnet-4-5': p(3, 15),
  'claude-sonnet-4': p(3, 15),
  'claude-haiku-4-5': p(1, 5),
  'claude-haiku-3-5': p(0.8, 4),
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** The price of a model id such as `claude-opus-5-5` or `claude-haiku-4-5-20251001`; undefined for anything else. */
export function priceOf(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  for (const key of KEYS) {
    if (!model.startsWith(key)) continue;
    const rest = model.slice(key.length);
    // only the id itself, a dated snapshot or a context suffix: `claude-opus-5-6` must not be priced as `claude-opus-5`
    if (/^(-\d{8})?(\[\w+\])?$/.test(rest) || rest === '-latest') return PRICES[key];
  }
  return undefined;
}

/** The token counts of one model response, as in `message.usage` of a Claude Code transcript line. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface TurnCost {
  /** Dollars; undefined when any model in the answer has no known price. */
  usd?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The model that did most of the work. */
  model?: string;
  /** How many model responses the answer took (tool calls make several). */
  messages: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

interface Seen extends Tokens {
  model?: string;
  fast: boolean;
  us: boolean;
}

function readUsage(message: Record<string, unknown>): Seen | undefined {
  const u = message.usage;
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  const cc = r.cache_creation && typeof r.cache_creation === 'object' ? (r.cache_creation as Record<string, unknown>) : undefined;
  return {
    input: num(r.input_tokens),
    output: num(r.output_tokens),
    cacheRead: num(r.cache_read_input_tokens),
    // without the split, everything written to the cache is priced as the short (5 minute) kind
    cacheWrite5m: cc ? num(cc.ephemeral_5m_input_tokens) : num(r.cache_creation_input_tokens),
    cacheWrite1h: cc ? num(cc.ephemeral_1h_input_tokens) : 0,
    model: typeof message.model === 'string' ? message.model : undefined,
    fast: r.speed === 'fast',
    us: r.inference_geo === 'us',
  };
}

/** What one response is worth at list price; undefined without a price. */
export function responseCost(t: Tokens, model: string | undefined, opts: { fast?: boolean; us?: boolean } = {}): number | undefined {
  const price = priceOf(model);
  if (!price) return undefined;
  const mult = (opts.fast && price.fast ? price.fast : 1) * (opts.us ? 1.1 : 1);
  return ((t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite5m * price.cacheWrite5m + t.cacheWrite1h * price.cacheWrite1h) / 1e6) * mult;
}

/** One response, by its id: the largest numbers of its lines, and the time of its latest line (`timestamp`, when there is one). */
function collect(lines: Iterable<string>): { byId: Map<string, Seen & { at?: number }>; lastId?: string } {
  const byId = new Map<string, Seen & { at?: number }>();
  let n = 0;
  let lastId: string | undefined;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let d: { type?: unknown; message?: Record<string, unknown>; requestId?: unknown; timestamp?: unknown; isSidechain?: unknown };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' || !d.message || typeof d.message !== 'object') continue;
    if (d.message.model === '<synthetic>') continue; // Claude Code's own error and notice messages, not a model response
    const seen = readUsage(d.message);
    if (!seen) continue;
    const id = typeof d.message.id === 'string' ? d.message.id : typeof d.requestId === 'string' ? d.requestId : `line-${n++}`;
    const t = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
    const prev = byId.get(id);
    const at = Math.max(prev?.at ?? -Infinity, Number.isFinite(t) ? t : -Infinity);
    byId.set(id, {
      ...(prev
        ? { ...seen, input: Math.max(prev.input, seen.input), output: Math.max(prev.output, seen.output), cacheRead: Math.max(prev.cacheRead, seen.cacheRead), cacheWrite5m: Math.max(prev.cacheWrite5m, seen.cacheWrite5m), cacheWrite1h: Math.max(prev.cacheWrite1h, seen.cacheWrite1h) }
        : seen),
      ...(Number.isFinite(at) ? { at } : {}),
    });
    if (d.isSidechain !== true) lastId = id; // (a subagent's response costs, but it is not the main conversation's context)
  }
  return { byId, lastId };
}

/**
 * The cost of the model responses in these transcript lines. Claude Code writes one line per content block of a response and
 * repeats the response's usage on each, so a response counts once (by message id; the largest count wins in case a line
 * was written before the response was complete).
 */
export function summarizeLines(lines: Iterable<string>): TurnCost | undefined {
  return summarizeTurn(lines).cost;
}

/**
 * (1.4.0) The cost of these lines (as `summarizeLines`) and, from the same pass, the context of the latest response: what it read in
 * (new input, cache written and cache read; never its output) and its model's id, for the context meter.
 */
export function summarizeTurn(lines: Iterable<string>): { cost?: TurnCost; context?: { tokens: number; model?: string } } {
  const { byId, lastId } = collect(lines);
  if (!byId.size) return {};
  const out: TurnCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: byId.size };
  let usd: number | undefined = 0;
  const weight = new Map<string, number>();
  for (const s of byId.values()) {
    out.input += s.input;
    out.output += s.output;
    out.cacheRead += s.cacheRead;
    out.cacheWrite += s.cacheWrite5m + s.cacheWrite1h;
    const c = responseCost(s, s.model, { fast: s.fast, us: s.us });
    usd = usd === undefined || c === undefined ? undefined : usd + c;
    if (s.model) weight.set(s.model, (weight.get(s.model) ?? 0) + s.input + s.output + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h);
  }
  out.model = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (usd !== undefined) out.usd = usd;
  const last = lastId === undefined ? undefined : byId.get(lastId)!;
  return { cost: out, ...(last ? { context: { tokens: last.input + last.cacheWrite5m + last.cacheWrite1h + last.cacheRead, ...(last.model ? { model: last.model } : {}) } } : {}) };
}

/**
 * (1.4.0) Each response of these lines once: its id (to count it once across files: a resumed conversation repeats responses in its new
 * file), the time of its latest line (one without a time is left out), all its tokens and its price when its model has one.
 */
export function usageByTime(lines: Iterable<string>): { id: string; at: number; tokens: number; usd?: number }[] {
  return [...collect(lines).byId.entries()]
    .filter((e): e is [string, Seen & { at: number }] => e[1].at !== undefined)
    .map(([id, s]) => {
      const usd = responseCost(s, s.model, { fast: s.fast, us: s.us });
      return { id, at: s.at, tokens: s.input + s.output + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h, ...(usd !== undefined ? { usd } : {}) };
    });
}

/**
 * (1.4.0) How many tokens a model's context window holds, by its id: 1M for the families the docs give a million tokens (Fable 5.x,
 * Mythos 5.x, Opus 5.x, Opus 4.7 and later 4.x, Sonnet 5.x, Haiku 5.x) and for an id with the `[1m]` suffix, 200k for any other Claude
 * model, undefined for an id it cannot read (the meter then shows the tokens alone). Checked against Anthropic's docs of 2026-10-16:
 * update it with the page, not from memory.
 */
export function contextWindow(model: string): number | undefined {
  if (typeof model !== 'string' || !/^claude-[a-z]/.test(model)) return undefined;
  if (model.endsWith('[1m]') || /^claude-(fable|mythos|opus|sonnet)-5(?:$|-|\[)/.test(model) || /^claude-haiku-5-5(?:$|-|\[)/.test(model)) return 1_000_000;
  if (model.startsWith('claude-haiku-5')) return undefined; // (the docs name Haiku 5.5 only: another Haiku 5 gets tokens only)
  const opus4 = /^claude-opus-4-(\d{1,2})(?:$|-|\[)/.exec(model);
  return opus4 && Number(opus4[1]) >= 7 ? 1_000_000 : 200_000;
}

/** What the answers finished on one local day (`YYYY-MM-DD`) cost, in estimated dollars, and how long Claude worked on them. */
export interface DayTotal {
  usd: number;
  date: string;
  /** The time of the turns finished that day (only once one was; turns under a second are not counted). */
  workMs?: number;
}

/** `prev` with `usd` and `workMs` more at the time `now`: a new local day starts again from nothing. */
export function dayTotal(prev: DayTotal | undefined, now: number, usd = 0, workMs = 0): DayTotal {
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const work = (prev?.date === date ? prev.workMs ?? 0 : 0) + (Number.isFinite(workMs) && workMs >= 1000 ? workMs : 0);
  return { usd: (prev?.date === date ? prev.usd : 0) + usd, date, ...(work > 0 ? { workMs: work } : {}) };
}

/** `$0.04`, `$1.84`, `<$0.01`, `$120`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** `850`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}
