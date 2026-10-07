import fs from 'node:fs';

/** The lines Claude Code writes to its transcript when the user declines a permission prompt in the terminal. */
const MARKERS = ['User rejected tool use', '[Request interrupted by user'];
const MAX_READ = 1024 * 1024;

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Declining a prompt in the terminal fires no hook, so while a session waits for the user the daemon reads the tail
 * of its transcript for the rejection line. Lines already in the file are ignored; `onRejected` is called once, then
 * the watch stops itself. Returns a function that stops it earlier.
 */
export function watchRejection(file: string, onRejected: () => void, opts: { intervalMs?: number } = {}): () => void {
  let offset = sizeOf(file);
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const size = fs.statSync(file).size;
      if (size < offset) offset = 0; // the file was replaced
      if (size === offset) return;
      const from = Math.max(offset, size - MAX_READ);
      const buf = Buffer.alloc(size - from);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, from);
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
      const text = buf.toString('utf8');
      if (MARKERS.some((m) => text.includes(m))) {
        stop();
        onRejected();
      }
    } catch {
      /* not there yet, or unreadable: try again next time */
    }
  }, opts.intervalMs ?? 500);
  timer.unref?.();
  return stop;
}
