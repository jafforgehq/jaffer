import fs from 'node:fs';
import path from 'node:path';

/**
 * (1.4.1) The one way a Claude Code transcript is opened, by every reader (the list, the search, the last 5 hours, Explain and the cost
 * readers): `file`'s real path must be a `.jsonl` file inside `realpath(<claudeDir>/projects)`, a regular file (a FIFO, socket or device
 * is refused before it is opened: opening a FIFO would block a thread of the daemon for ever), opened read-only without following a
 * link swapped in since (`O_NOFOLLOW`, and `O_NONBLOCK` in case one was), and checked again once open. Null on anything else; it never
 * throws. The caller closes `fh`.
 */
export async function openTranscript(claudeDir: string, file: string): Promise<{ fh: fs.promises.FileHandle; size: number } | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    const root = await fs.promises.realpath(path.join(claudeDir, 'projects'));
    const real = await fs.promises.realpath(file);
    if (!real.startsWith(root + path.sep) || !real.endsWith('.jsonl')) return null;
    if (!(await fs.promises.lstat(real)).isFile()) return null;
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    return { fh, size: st.size };
  } catch {
    await fh?.close().catch(() => undefined);
    return null;
  }
}
