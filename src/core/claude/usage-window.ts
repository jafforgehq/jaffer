import fs from 'node:fs';
import path from 'node:path';
import { usageByTime } from '../../shared/claude-cost';
import { MAX_READ } from './cost';
import { transcriptFiles } from './history';

/**
 * The last 5 hours (1.4.0): the tokens of the model responses written in the last 5 hours across Claude Code's transcripts, and what
 * they are worth at API list prices (an estimate; not the person's plan or its limits). Read only the token counts and the time of each
 * response line, with the confinement of the past conversations (`transcriptFiles`: real folders, regular `<uuid>.jsonl` files, the real
 * path inside the projects folder, opened without following a link), the newest 60 files written in the window. Each file is read from
 * its end in 1 MB chunks, back to the first response older than the window (at most its last 24 MB), with a turn of the event loop
 * between chunks and files; a response is counted once across files (by its id: a resumed conversation repeats responses). Overlapping
 * calls share one scan. Kept only in memory (numbers and response ids by file, by size and mtime).
 */
export const WINDOW_MS = 5 * 3_600_000;
export const MAX_FILES = 60;
const CHUNK = 1024 * 1024;

/** Bytes read from transcripts so far (for the tests: a scan that stops early reads little). */
export const scanStats = { bytes: 0 };

type Entry = { id: string; at: number; tokens: number; usd?: number };
type Usage = { tokens: number; usd?: number; files: number };
const cache = new Map<string, { stamp: string; entries: Entry[] }>();
const CACHE_MAX = 200;
let inflight: Promise<Usage> | null = null;

const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

export function recentUsage(claudeDir: string, now: number): Promise<Usage> {
  inflight ??= scan(claudeDir, now).finally(() => (inflight = null));
  return inflight;
}

async function scan(claudeDir: string, now: number): Promise<Usage> {
  const t = await transcriptFiles(claudeDir);
  let tokens = 0;
  let usd: number | undefined;
  let files = 0;
  const since = now - WINDOW_MS;
  const counted = new Set<string>();
  for (const f of (t?.found ?? []).filter((x) => x.mtimeMs > since).slice(0, MAX_FILES)) {
    const entries = await readEntries(t!.root, f.file, since);
    await yieldTurn();
    if (!entries) continue;
    files++;
    for (const e of entries) {
      if (e.at <= since || counted.has(e.id)) continue;
      counted.add(e.id);
      tokens += e.tokens;
      if (e.usd !== undefined) usd = (usd ?? 0) + e.usd;
    }
  }
  return { tokens, ...(usd !== undefined ? { usd } : {}), files };
}

/** One transcript's responses newer than `since` (a cached read when its size and mtime did not change: what aged out goes). */
async function readEntries(root: string, file: string, since: number): Promise<Entry[] | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    const real = await fs.promises.realpath(file);
    if (!real.startsWith(root + path.sep)) return undefined;
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const stamp = `${st.size}:${st.mtimeMs}`;
    let seen = cache.get(file);
    if (seen?.stamp !== stamp) {
      seen = { stamp, entries: await readBack(fh, st.size, since) };
      cache.delete(file);
      cache.set(file, seen);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    seen.entries = seen.entries.filter((e) => e.at > since); // (time only goes on: what is out now stays out)
    return seen.entries;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * The responses of a file from its end, a chunk at a time: the bytes before a chunk's first newline wait for the chunk before it (a line
 * is only read whole; a newline byte never sits inside a UTF-8 character). It stops at the first response older than `since`, at the
 * start of the file, or after `MAX_READ` bytes. Of a response seen in two chunks, its later lines (seen first) count.
 */
async function readBack(fh: fs.promises.FileHandle, size: number, since: number): Promise<Entry[]> {
  const out = new Map<string, Entry>();
  let pos = size;
  let carry = Buffer.alloc(0);
  while (pos > 0 && size - pos < MAX_READ) {
    const len = Math.min(CHUNK, pos, MAX_READ - (size - pos));
    pos -= len;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    scanStats.bytes += bytesRead;
    let text = Buffer.concat([buf.subarray(0, bytesRead), carry]);
    if (pos > 0) {
      const nl = text.indexOf(0x0a);
      carry = nl < 0 ? text : text.subarray(0, nl);
      text = nl < 0 ? Buffer.alloc(0) : text.subarray(nl + 1);
    } else carry = Buffer.alloc(0);
    let older = false;
    for (const e of usageByTime(text.toString('utf8').split('\n'))) {
      if (e.at <= since) older = true;
      else if (!out.has(e.id)) out.set(e.id, e);
    }
    if (older) break;
    await yieldTurn();
  }
  return [...out.values()];
}
