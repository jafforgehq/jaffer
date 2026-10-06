/** Small, dependency-free text utilities: tokenising, similarity and BM25 ranking. */

const STOP = new Set(
  (
    'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those ' +
    'i you he she we they me my your our their do does did doing have has had not no yes so than too very can could should would will just ' +
    'use using used when where which who whom how what why also into over under about after before up down out more most some any each other'
  ).split(' '),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const w = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Overlap coefficient — better than Jaccard when one text is a short restatement of a longer one. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  return Math.max(jaccard(sa, sb), overlap(sa, sb) * 0.9);
}

export interface Doc {
  id: string;
  text: string;
}

export interface Scored {
  id: string;
  score: number;
}

/** Okapi BM25 over a small in-memory corpus. Good enough for hundreds of notes; no index to maintain. */
export function bm25(docs: Doc[], query: string, k1 = 1.4, b = 0.75): Scored[] {
  const q = tokenize(query);
  if (q.length === 0 || docs.length === 0) return [];
  const tokenized = docs.map((d) => ({ id: d.id, toks: tokenize(d.text) }));
  const avgLen = tokenized.reduce((s, d) => s + d.toks.length, 0) / tokenized.length || 1;
  const df = new Map<string, number>();
  for (const d of tokenized) for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = tokenized.length;
  const out: Scored[] = [];
  for (const d of tokenized) {
    const tf = new Map<string, number>();
    for (const t of d.toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(q)) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.toks.length) / avgLen));
    }
    if (score > 0) out.push({ id: d.id, score });
  }
  return out.sort((x, y) => y.score - x.score);
}
