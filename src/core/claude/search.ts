import fs from 'node:fs';
import { lines, readAt, transcriptFiles } from './history';
import { openTranscript } from './transcript-open';

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
/** The newest search: an older one still scanning stops at its next file (the panel only wants the newest answer). */
let newest = 0;

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
  const mine = ++newest;
  const needle = text.toLowerCase();
  const raw = JSON.stringify(needle).slice(1, -1); // (as it is written in a JSON line: a line that does not hold this is not parsed)
  const start = Date.now();
  const budget = opts.budgetMs ?? BUDGET_MS;
  const t = await transcriptFiles(claudeDir);
  const hits = new Map<string, number>();
  let partial = false;
  for (const f of (t?.found ?? []).slice(0, SEARCH_FILES)) {
    if (mine !== newest) return { hits: [], partial: true };
    if (Date.now() - start >= budget) {
      partial = true;
      break;
    }
    const n = await countFile(claudeDir, f.file, needle, raw);
    if (n) hits.set(f.id, Math.min(MAX_COUNT, (hits.get(f.id) ?? 0) + n));
    await new Promise((r) => setImmediate(r)); // (the daemon also relays the terminals: let it between files)
  }
  return { hits: [...hits].map(([id, count]) => ({ id, count })), partial };
}

async function countFile(claudeDir: string, file: string, needle: string, raw: string): Promise<number> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    const opened = await openTranscript(claudeDir, file);
    if (!opened) return 0;
    fh = opened.fh;
    const st = { size: opened.size };
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

/**
 * The text of a user or assistant message on this line: its content when that is a string, else its `text` parts; nothing else. Not a
 * meta, compaction or sidechain line, and not a text that starts with `<` (as the title reader: `!` command output, a slash command's
 * output, a hook's text are tags, not anyone's words).
 */
function messageText(line: string): string[] {
  let o: { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isSidechain?: unknown; message?: { content?: unknown } } | undefined;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || typeof o !== 'object' || (o.type !== 'user' && o.type !== 'assistant') || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) return [];
  const c = o.message && typeof o.message === 'object' ? o.message.content : undefined;
  const words = (s: string) => !s.trimStart().startsWith('<');
  if (typeof c === 'string') return words(c) ? [c] : [];
  if (!Array.isArray(c)) return [];
  return c.flatMap((p: { type?: unknown; text?: unknown }) => (p?.type === 'text' && typeof p.text === 'string' && words(p.text) ? [p.text] : []));
}

function countIn(text: string, needle: string, max: number): number {
  const t = text.toLowerCase();
  let n = 0;
  for (let i = t.indexOf(needle); i !== -1 && n < max; i = t.indexOf(needle, i + needle.length)) n++;
  return n;
}
