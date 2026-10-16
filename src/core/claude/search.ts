import fs from 'node:fs';
import path from 'node:path';
import { lines, readAt, transcriptFiles } from './history';

/**
 * Deep search (1.4.0, only with `permissions.deepSearch`): which past conversations hold a text, and how often. It looks only at the
 * text of the messages (a user or assistant line's `message.content` when it is a string, else its `text` parts: never a tool call, a
 * tool result, thinking, a summary or any other field), case-insensitively, as a plain substring. The 200 newest transcripts, confined as
 * for the list, at most 2 MB of each (its head and its tail), 5 s at most in all. The answer is ids and counts only: no text of a
 * transcript leaves this file, and nothing of it is kept or logged.
 */
export const SEARCH_FILES = 200;
const HALF = 1024 * 1024;
const MAX_COUNT = 99;
const BUDGET_MS = 5000;

/** The query: trimmed, 3 to 64 characters, no control character; undefined otherwise. */
export function searchQuery(q: unknown): string | undefined {
  if (typeof q !== 'string' || q.length > 1024) return undefined;
  const t = q.trim();
  const n = Array.from(t).length;
  return n >= 3 && n <= 64 && !/\p{Cc}/u.test(t) ? t : undefined;
}

export async function searchConversations(claudeDir: string, q: unknown, opts: { budgetMs?: number } = {}): Promise<{ hits: { id: string; count: number }[]; partial: boolean }> {
  const text = searchQuery(q);
  if (!text) throw new RangeError('Search for 3 to 64 characters, without control characters.');
  const needle = text.toLowerCase();
  const raw = JSON.stringify(needle).slice(1, -1); // (as it is written in a JSON line: a line that does not hold this is not parsed)
  const start = Date.now();
  const budget = opts.budgetMs ?? BUDGET_MS;
  const t = await transcriptFiles(claudeDir);
  const hits = new Map<string, number>();
  let partial = false;
  for (const f of (t?.found ?? []).slice(0, SEARCH_FILES)) {
    if (Date.now() - start >= budget) {
      partial = true;
      break;
    }
    const n = await countFile(t!.root, f.file, needle, raw);
    if (n) hits.set(f.id, Math.min(MAX_COUNT, (hits.get(f.id) ?? 0) + n));
    await new Promise((r) => setImmediate(r)); // (the daemon also relays the terminals: let it between files)
  }
  return { hits: [...hits].map(([id, count]) => ({ id, count })), partial };
}

async function countFile(root: string, file: string, needle: string, raw: string): Promise<number> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    const real = await fs.promises.realpath(file);
    if (!real.startsWith(root + path.sep)) return 0;
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return 0;
    const ls =
      st.size <= 2 * HALF
        ? lines(await readAt(fh, 0, st.size), true, true)
        : [...lines(await readAt(fh, 0, HALF), true, false), ...lines(await readAt(fh, st.size - HALF, HALF), false, true)];
    let n = 0;
    for (const line of ls) {
      if (n >= MAX_COUNT) break;
      if (!line.toLowerCase().includes(raw)) continue;
      for (const s of messageText(line)) n += countIn(s, needle, MAX_COUNT - n);
    }
    return n;
  } catch {
    return 0;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** The text of a user or assistant message on this line: its content when that is a string, else its `text` parts; nothing else. */
function messageText(line: string): string[] {
  let o: { type?: unknown; message?: { content?: unknown } } | undefined;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || typeof o !== 'object' || (o.type !== 'user' && o.type !== 'assistant')) return [];
  const c = o.message && typeof o.message === 'object' ? o.message.content : undefined;
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  return c.flatMap((p: { type?: unknown; text?: unknown }) => (p?.type === 'text' && typeof p.text === 'string' ? [p.text] : []));
}

function countIn(text: string, needle: string, max: number): number {
  const t = text.toLowerCase();
  let n = 0;
  for (let i = t.indexOf(needle); i !== -1 && n < max; i = t.indexOf(needle, i + needle.length)) n++;
  return n;
}
