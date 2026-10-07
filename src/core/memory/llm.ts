/** The minimal text-completion surface the memory system needs from a model. */
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens?: number; model?: string }): Promise<string>;
}

/** Extract the first balanced top-level JSON object/array from model output (tolerates prose and ``` fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const src of candidates) {
    let from = 0;
    for (let tries = 0; tries < 200; tries++) {
      const rel = src.slice(from).search(/[[{]/);
      if (rel < 0) break;
      const start = from + rel;
      const end = balancedEnd(src, start);
      if (end >= 0) {
        try {
          return JSON.parse(src.slice(start, end + 1));
        } catch {
          /* prose in brackets, not JSON: look at the next opener */
        }
      }
      from = start + 1;
    }
  }
  return null;
}

/** Index of the bracket that closes the one at `start` (strings and escapes respected), or -1. */
function balancedEnd(src: string, start: number): number {
  const open = src[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}
