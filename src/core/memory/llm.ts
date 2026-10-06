/** The minimal text-completion surface the memory system needs from a model. */
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens?: number; model?: string }): Promise<string>;
}

/** Extract the first balanced top-level JSON object/array from model output (tolerates prose and ``` fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const src of candidates) {
    const start = src.search(/[[{]/);
    if (start < 0) continue;
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
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(src.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
