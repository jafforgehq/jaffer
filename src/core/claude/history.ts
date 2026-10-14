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
  /** For the 30 newest: Claude's summary or title, else the first user message's first line; redacted, at most 80 characters. */
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

export async function listConversations(opts: { claudeDir: string; limit?: number; withCost?: boolean }): Promise<Conversation[]> {
  let root: string;
  try {
    root = await fs.promises.realpath(path.join(opts.claudeDir, 'projects'));
  } catch {
    return []; // Claude Code never ran here
  }
  const found: { file: string; id: string; mtimeMs: number }[] = [];
  for (const dir of await names(root)) {
    const d = path.join(root, dir);
    if (!(await fs.promises.lstat(d).catch(() => null))?.isDirectory()) continue; // a link is not followed, wherever it leads
    for (const name of await names(d)) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -6) : '';
      if (!isSessionId(id)) continue;
      const file = path.join(d, name);
      const st = await fs.promises.lstat(file).catch(() => null);
      if (st?.isFile()) found.push({ file, id, mtimeMs: st.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: Conversation[] = [];
  for (const f of found.slice(0, opts.limit ?? 50)) {
    const conv = await readOne(root, f.file, f.id, out.length < COSTED, opts.withCost === true);
    if (conv) out.push(conv);
  }
  return out;
}

async function names(dir: string): Promise<string[]> {
  return fs.promises.readdir(dir).catch(() => []);
}

async function readOne(root: string, file: string, id: string, newest: boolean, wantCost: boolean): Promise<Conversation | undefined> {
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
    if (newest && seen.title === undefined) seen.title = (await readTitle(fh, st.size)) ?? null;
    const usd = withCost ? seen.usd : undefined;
    const conv: Conversation = typeof usd === 'number' ? { ...seen.conv, usd } : { ...seen.conv };
    if (newest && seen.title) conv.title = seen.title;
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

async function readAt(fh: fs.promises.FileHandle, position: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.toString('utf8', 0, bytesRead);
}

/** The whole lines of a stretch of the file: a piece cut by the start or the end of the stretch is not a line. */
function lines(text: string, atStart: boolean, atEnd: boolean): string[] {
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
