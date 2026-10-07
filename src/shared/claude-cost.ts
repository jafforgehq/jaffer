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

/**
 * The cost of the model responses in these transcript lines. Claude Code writes one line per content block of a response and
 * repeats the response's usage on each, so a response counts once (by message id; the largest count wins in case a line
 * was written before the response was complete).
 */
export function summarizeLines(lines: Iterable<string>): TurnCost | undefined {
  const byId = new Map<string, Seen>();
  let n = 0;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let d: { type?: unknown; message?: Record<string, unknown>; requestId?: unknown };
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
    const prev = byId.get(id);
    byId.set(
      id,
      prev
        ? { ...seen, input: Math.max(prev.input, seen.input), output: Math.max(prev.output, seen.output), cacheRead: Math.max(prev.cacheRead, seen.cacheRead), cacheWrite5m: Math.max(prev.cacheWrite5m, seen.cacheWrite5m), cacheWrite1h: Math.max(prev.cacheWrite1h, seen.cacheWrite1h) }
        : seen,
    );
  }
  if (!byId.size) return undefined;
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
  return out;
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
