import fs from 'node:fs';
import path from 'node:path';
import { usageByTime } from '../../shared/claude-cost';
import { MAX_READ } from './cost';
import { transcriptFiles } from './history';

/**
 * The last 5 hours (1.4.0): the tokens of the model responses written in the last 5 hours across Claude Code's transcripts, and what
 * they are worth at API list prices (an estimate; not the person's plan or its limits). Read only the token counts and the time of each
 * response line, with the confinement of the past conversations (`transcriptFiles`: real folders, regular `<uuid>.jsonl` files, the real
 * path inside the projects folder, opened without following a link), the newest 60 files written in the window, the last 24 MB of each.
 * Kept only in memory (numbers by file, by size and mtime).
 */
export const WINDOW_MS = 5 * 3_600_000;
export const MAX_FILES = 60;

type Entry = { at: number; tokens: number; usd?: number };
const cache = new Map<string, { stamp: string; entries: Entry[] }>();
const CACHE_MAX = 200;

export async function recentUsage(claudeDir: string, now: number): Promise<{ tokens: number; usd?: number; files: number }> {
  const t = await transcriptFiles(claudeDir);
  let tokens = 0;
  let usd: number | undefined;
  let files = 0;
  const since = now - WINDOW_MS;
  for (const f of (t?.found ?? []).filter((x) => x.mtimeMs > since).slice(0, MAX_FILES)) {
    const entries = await readEntries(t!.root, f.file, since);
    if (!entries) continue;
    files++;
    for (const e of entries) {
      if (e.at <= since) continue;
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
      const from = Math.max(0, st.size - MAX_READ);
      const buf = Buffer.alloc(st.size - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      const lines = buf.toString('utf8', 0, bytesRead).split('\n');
      if (from > 0) lines.shift(); // (it began inside a line)
      seen = { stamp, entries: usageByTime(lines) };
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
