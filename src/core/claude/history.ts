import fs from 'node:fs';
import path from 'node:path';
import { summarizeLines } from '../../shared/claude-cost';
import { COMMAND_HEAD } from '../../shared/process-badge';
import { redactText } from '../../shared/redact';
import { isSessionId } from '../../shared/session-id';
import { MAX_READ } from './cost';

/**
 * Past Claude Code conversations, from the transcripts Claude Code keeps in `<claudeDir>/projects/<folder>/<session id>.jsonl`. Read
 * only, and only this: the file name (the session id), the `cwd` of its first lines, its first and last timestamps, for the newest a
 * title (Claude's own summary or title line, else the first line of the first real user message: redacted, one line, 80 characters)
 * and (asked for) their token counts. Never another prompt, a reply, a tool input or anything else; nothing of it is written anywhere.
 */
export interface Conversation {
  id: string;
  /** The folder the conversation began in. */
  cwd?: string;
  startedAt?: number;
  /** The last timestamp in the transcript, or when the file was last written. */
  endedAt: number;
  durMs?: number;
  /** An estimate at API list prices (see `shared/claude-cost.ts`): only with `withCost`, for the 30 newest up to 24 MB. */
  usd?: number;
  /** For the 30 newest (and the included ones): Claude's summary or title, else the first user message's first line; redacted, at most 80 characters. */
  title?: string;
}

/** How much of each end of a transcript is read for its folder and its timestamps. */
const WINDOW = 64 * 1024;
const COSTED = 30;

interface Seen {
  stamp: string;
  conv: Conversation;
  /** null: counted, and nothing to say. */
  usd?: number | null;
  /** null: looked for, and none. */
  title?: string | null;
}

/** What was read of a transcript, by path and size+mtime, so a list asked again reads only what changed. In memory only. */
const cache = new Map<string, Seen>();
const CACHE_MAX = 500;

/**
 * The newest `limit` conversations, newest first, and (1.2.0) those of `include` (the pinned ones: session ids only, the first 50 entries
 * looked at) even when they are older: listed after the others, with their title, a cost only when they are among the 30 newest.
 */
export async function listConversations(opts: { claudeDir: string; limit?: number; withCost?: boolean; include?: unknown }): Promise<Conversation[]> {
  const t = await transcriptFiles(opts.claudeDir);
  if (!t) return []; // Claude Code never ran here
  const { root, found } = t;
  const limit = opts.limit ?? 50;
  const include = new Set(Array.isArray(opts.include) ? opts.include.slice(0, 50).filter((x): x is string => typeof x === 'string' && isSessionId(x)) : []);
  const out: Conversation[] = [];
  for (const [i, f] of found.entries()) {
    if (i >= limit && !include.has(f.id)) continue;
    const conv = await readOne(root, f.file, f.id, i < limit && out.length < COSTED, opts.withCost === true, i < limit ? out.length < COSTED : true);
    if (conv) out.push(conv);
  }
  return out;
}

/**
 * The transcripts: `<root>/<folder>/<uuid>.jsonl`, regular files in real folders only (a link is not followed, a subfolder not entered),
 * newest first; `root` is `realpath(<claudeDir>/projects)`. Undefined when there is no such folder.
 */
export async function transcriptFiles(claudeDir: string): Promise<{ root: string; found: { file: string; id: string; mtimeMs: number; size: number }[] } | undefined> {
  let root: string;
  try {
    root = await fs.promises.realpath(path.join(claudeDir, 'projects'));
  } catch {
    return undefined;
  }
  const found: { file: string; id: string; mtimeMs: number; size: number }[] = [];
  for (const dir of await names(root)) {
    const d = path.join(root, dir);
    if (!(await fs.promises.lstat(d).catch(() => null))?.isDirectory()) continue; // a link is not followed, wherever it leads
    for (const name of await names(d)) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : '';
      if (!isSessionId(id)) continue;
      const file = path.join(d, name);
      const st = await fs.promises.lstat(file).catch(() => null);
      if (st?.isFile()) found.push({ file, id, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { root, found };
}

/** What moving a conversation to the Trash takes: its transcript and, when there is one, its folder of the same name beside it. */
export interface ConversationFiles {
  id: string;
  file: string;
  /** Claude Code's subagent transcripts and tool results for this conversation. */
  dir?: string;
}

/** The most ids `conversationFiles` looks at (one removal: a folder's list, or all of it, is fewer). */
export const MAX_REMOVE = 200;

/**
 * (1.3.0) The files of these conversations (session ids only, the first 200 looked at), in the order of `ids`: `<folder>/<id>.jsonl` at the
 * top of a project folder and its sibling folder `<folder>/<id>/`. Only a real folder and a regular file count, a link is never followed,
 * and each real path is inside `realpath(<claudeDir>/projects)`. Reads names only, changes nothing; the paths are what main may trash.
 */
export async function conversationFiles(claudeDir: string, ids: unknown): Promise<ConversationFiles[]> {
  const want = new Set(Array.isArray(ids) ? ids.slice(0, MAX_REMOVE).filter((x): x is string => typeof x === 'string' && isSessionId(x)) : []);
  if (!want.size) return [];
  let root: string;
  try {
    root = await fs.promises.realpath(path.join(claudeDir, 'projects'));
  } catch {
    return [];
  }
  const inside = async (p: string) => (await fs.promises.realpath(p).catch(() => '')) === p && p.startsWith(root + path.sep);
  const found = new Map<string, ConversationFiles[]>();
  for (const folder of (await names(root)).sort()) {
    const d = path.join(root, folder);
    if (!(await fs.promises.lstat(d).catch(() => null))?.isDirectory()) continue; // a link is not followed, wherever it leads
    const here = new Set(await names(d));
    for (const id of want) {
      const file = path.join(d, `${id}.jsonl`);
      if (!here.has(`${id}.jsonl`) || !(await fs.promises.lstat(file).catch(() => null))?.isFile() || !(await inside(file))) continue;
      const entry: ConversationFiles = { id, file };
      const dir = path.join(d, id);
      if (here.has(id) && (await fs.promises.lstat(dir).catch(() => null))?.isDirectory() && (await inside(dir))) entry.dir = dir;
      found.set(id, [...(found.get(id) ?? []), entry]);
    }
  }
  return [...want].flatMap((id) => found.get(id) ?? []);
}

/** (1.4.0) What the transcripts take on disk: all of them, and the 10 biggest (a title only when the list already read it). */
export interface Storage {
  totalBytes: number;
  count: number;
  biggest: { id: string; title?: string; cwd?: string; bytes: number; endedAt: number }[];
}

const STORAGE_TTL = 30_000;
/** The most entries counted in one conversation's folder (subagent transcripts, tool results). */
const DIR_MAX = 5000;
let storageSeen: { stamp: string; at: number; value: Storage } | undefined;

/**
 * (1.4.0) The size of each `<id>.jsonl` (confined as for the list) plus its sibling real folder `<id>/` (links skipped, at most 5000
 * entries walked), their total and the 10 biggest with their folder and end (the head and tail read of the list, cached) and their title
 * only when the list already has it: no other text is read. Kept 30 s while the project folders did not change. Changes nothing.
 */
export async function conversationStorage(claudeDir: string, now = Date.now()): Promise<Storage> {
  const stamp = await projectsStamp(claudeDir);
  if (storageSeen?.stamp === stamp && now - storageSeen.at >= 0 && now - storageSeen.at < STORAGE_TTL) return storageSeen.value;
  const t = await transcriptFiles(claudeDir);
  if (!t) return { totalBytes: 0, count: 0, biggest: [] };
  const sized: { file: string; id: string; bytes: number }[] = [];
  for (const f of t.found) sized.push({ file: f.file, id: f.id, bytes: f.size + (await dirBytes(t.root, path.join(path.dirname(f.file), f.id))) });
  const biggest: Storage['biggest'] = [];
  for (const f of [...sized].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
    const conv = await readOne(t.root, f.file, f.id, false, false, false);
    const title = cache.get(f.file)?.title;
    biggest.push({ id: f.id, ...(typeof title === 'string' ? { title } : {}), ...(conv?.cwd ? { cwd: conv.cwd } : {}), bytes: f.bytes, endedAt: conv?.endedAt ?? 0 });
  }
  const value = { totalBytes: sized.reduce((a, f) => a + f.bytes, 0), count: sized.length, biggest };
  storageSeen = { stamp, at: now, value };
  return value;
}

/** The project folders and when each last changed (a transcript added or removed): cheap, one `lstat` a folder. */
async function projectsStamp(claudeDir: string): Promise<string> {
  const root = await fs.promises.realpath(path.join(claudeDir, 'projects')).catch(() => '');
  if (!root) return '';
  const parts = [root];
  for (const n of (await names(root)).sort()) parts.push(`${n}:${(await fs.promises.lstat(path.join(root, n)).catch(() => null))?.mtimeMs ?? 0}`);
  return parts.join('\0');
}

/** The bytes of the regular files in a real folder inside `root` and its real subfolders: links skipped, at most 5000 entries. */
async function dirBytes(root: string, dir: string): Promise<number> {
  if (!(await fs.promises.lstat(dir).catch(() => null))?.isDirectory() || (await fs.promises.realpath(dir).catch(() => '')) !== dir || !dir.startsWith(root + path.sep)) return 0;
  let bytes = 0;
  let seen = 0;
  const todo = [dir];
  while (todo.length && seen < DIR_MAX) {
    const d = todo.pop()!;
    for (const n of await names(d)) {
      if (++seen > DIR_MAX) break;
      const p = path.join(d, n);
      const st = await fs.promises.lstat(p).catch(() => null);
      if (st?.isFile()) bytes += st.size;
      else if (st?.isDirectory()) todo.push(p);
    }
  }
  return bytes;
}

export const OLD_DAYS = [30, 60, 90];

/**
 * (1.4.0) Remove… → Older than 30, 60 or 90 days: of all the transcripts (confined as for the list), the ids last written before then,
 * oldest first, at most 200 (one removal), and how many there are in all. Any other number of days is refused.
 */
export async function oldConversations(claudeDir: string, days: unknown, now = Date.now()): Promise<{ ids: string[]; total: number }> {
  if (typeof days !== 'number' || !OLD_DAYS.includes(days)) throw new RangeError('The days must be 30, 60 or 90.');
  const cut = now - days * 86_400_000;
  const old = [...new Set(((await transcriptFiles(claudeDir))?.found ?? []).filter((f) => f.mtimeMs < cut).reverse().map((f) => f.id))];
  return { ids: old.slice(0, MAX_REMOVE), total: old.length };
}

async function names(dir: string): Promise<string[]> {
  return fs.promises.readdir(dir).catch(() => []);
}

async function readOne(root: string, file: string, id: string, newest: boolean, wantCost: boolean, titled: boolean): Promise<Conversation | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    // confined to the projects folder: the real path stays inside it, and the file is opened without following a link swapped in since
    const real = await fs.promises.realpath(file);
    if (!real.startsWith(root + path.sep)) return undefined;
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const stamp = `${st.size}:${st.mtimeMs}`;
    let seen = cache.get(file);
    if (seen?.stamp !== stamp) {
      seen = { stamp, conv: await readEnds(fh, id, st.size, st.mtimeMs) };
      cache.delete(file);
      cache.set(file, seen);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    const withCost = wantCost && newest;
    if (withCost && seen.usd === undefined) seen.usd = st.size <= MAX_READ ? (summarizeLines(lines(await readAt(fh, 0, st.size), true, true))?.usd ?? null) : null;
    if (titled && seen.title === undefined) seen.title = (await readTitle(fh, st.size)) ?? null;
    const usd = withCost ? seen.usd : undefined;
    const conv: Conversation = typeof usd === 'number' ? { ...seen.conv, usd } : { ...seen.conv };
    if (titled && seen.title) conv.title = seen.title;
    return conv;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** The folder and the first timestamp from the first 64 KB, the last timestamp from the last 64 KB. */
async function readEnds(fh: fs.promises.FileHandle, id: string, size: number, mtimeMs: number): Promise<Conversation> {
  let cwd: string | undefined;
  let startedAt: number | undefined;
  for (const d of fields(lines(await readAt(fh, 0, Math.min(size, WINDOW)), true, size <= WINDOW))) {
    cwd ??= d.cwd;
    startedAt ??= d.at;
    if (cwd && startedAt !== undefined) break;
  }
  let last: number | undefined;
  const from = Math.max(0, size - WINDOW);
  for (const d of fields(lines(await readAt(fh, from, size - from), from === 0, true))) last = d.at ?? last;
  const conv: Conversation = { id, endedAt: last ?? Math.round(mtimeMs) };
  if (cwd) conv.cwd = cwd;
  if (startedAt !== undefined) conv.startedAt = startedAt;
  if (startedAt !== undefined && last !== undefined) conv.durMs = Math.max(0, last - startedAt);
  return conv;
}

/** The person's latest own title, else Claude's latest AI title, else its latest summary (the tail first, then the head), else the first real user message of the head. */
async function readTitle(fh: fs.promises.FileHandle, size: number): Promise<string | undefined> {
  const head = lines(await readAt(fh, 0, Math.min(size, WINDOW)), true, size <= WINDOW);
  const from = Math.max(0, size - WINDOW);
  const tail = lines(await readAt(fh, from, size - from), from === 0, true);
  for (const key of ['customTitle', 'aiTitle', 'summary']) {
    for (const ls of [tail, head]) {
      for (let i = ls.length - 1; i >= 0; i--) {
        if (!ls[i]!.includes(`"${key}"`)) continue;
        const o = parse(ls[i]!);
        const t = key === 'summary' && o?.type !== 'summary' ? undefined : o?.[key];
        const title = typeof t === 'string' ? cleanTitle(t) : undefined;
        if (title) return title;
      }
    }
  }
  for (const line of head) {
    if (!line.includes('"user"')) continue;
    const o = parse(line);
    const m = o?.message as Record<string, unknown> | undefined;
    if (o?.type !== 'user' || o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true || !m || m.role !== 'user') continue;
    const c = m.content;
    const part = Array.isArray(c) ? (c as { type?: unknown; text?: unknown }[]).find((p) => p?.type === 'text') : undefined;
    const text = (typeof c === 'string' ? c : typeof part?.text === 'string' ? part.text : '').trim();
    if (!text || text.startsWith('<')) continue; // a system tag (<command-name>, <local-command-caveat>), not the person's words
    const title = cleanTitle(text.slice(0, COMMAND_HEAD).split('\n')[0]!);
    if (title) return title;
  }
  return undefined;
}

/** Redacted (before the cut to 80, so no token is half shown; 4 KB at most, which keeps 30 of them quick), one line without control or format characters. */
function cleanTitle(text: string): string | undefined {
  const one = redactText(text.slice(0, COMMAND_HEAD))
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(one);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : one || undefined;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const d: unknown = JSON.parse(line);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function readAt(fh: fs.promises.FileHandle, position: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.toString('utf8', 0, bytesRead);
}

/** The whole lines of a stretch of the file: a piece cut by the start or the end of the stretch is not a line. */
export function lines(text: string, atStart: boolean, atEnd: boolean): string[] {
  const out = text.split('\n');
  if (!atStart) out.shift();
  if (!atEnd) out.pop();
  return out;
}

/** Of each line, only its own `cwd` (a plain absolute path) and `timestamp`; everything else is dropped as soon as it is parsed. */
function* fields(ls: string[]): Generator<{ cwd?: string; at?: number }> {
  for (const line of ls) {
    if (!line.includes('"timestamp"') && !line.includes('"cwd"')) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const cwd = typeof o.cwd === 'string' && o.cwd.startsWith('/') && o.cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(o.cwd) ? o.cwd : undefined;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    yield { cwd, at: Number.isFinite(t) ? t : undefined };
  }
}
