import fs from 'node:fs';

const MARKER = '[Request interrupted by user';
const REJECTED = 'User rejected tool use';
const MAX_READ = 1024 * 1024;

const blocks = (content: unknown): { type?: unknown; text?: unknown; content?: unknown }[] => (Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : []);

/** The text of a message part: a string, or the text blocks of a list. */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  return blocks(content).flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : b.type === 'tool_result' ? texts(b.content) : []));
}

/**
 * Is this transcript line the one Claude Code writes when the person stopped it? Declining a prompt writes a user entry whose
 * `toolUseResult` is exactly "User rejected tool use"; Esc writes a user entry whose text starts with "[Request interrupted by
 * user". The same words also turn up in code Claude writes and in output of commands it runs (a grep of this very file), so
 * only the person's side of the conversation counts, and only when the text begins with the marker.
 */
export function isStopLine(line: string): boolean {
  if (!line.includes(MARKER) && !line.includes(REJECTED)) return false;
  try {
    const d = JSON.parse(line) as { type?: unknown; toolUseResult?: unknown; message?: { role?: unknown; content?: unknown } };
    if (d.type !== 'user') return false;
    if (d.toolUseResult === REJECTED) return true;
    return texts(d.message?.content).some((t) => t.startsWith(MARKER));
  } catch {
    return false;
  }
}

/** Was the transcript written to within `withinMs`? Claude Code writes it as it works, so a quiet file means a quiet Claude. */
export function transcriptActive(file: string | undefined, withinMs: number, now: number = Date.now()): boolean {
  if (!file) return false;
  try {
    return now - fs.statSync(file).mtimeMs < withinMs;
  } catch {
    return false;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Declining a prompt or pressing Esc in the terminal fires no hook, so while a session waits or works the daemon reads the tail
 * of its transcript for that line. Lines already in the file are ignored; `onStopped` is called once, then the watch stops
 * itself. Returns a function that stops it earlier.
 */
export function watchInterruption(file: string, onStopped: () => void, opts: { intervalMs?: number } = {}): () => void {
  let offset = sizeOf(file);
  let partial = ''; // the unfinished last line of the previous read
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const size = fs.statSync(file).size;
      if (size < offset) {
        offset = 0; // the file was replaced
        partial = '';
      }
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
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop() ?? '';
      if (lines.some(isStopLine)) {
        stop();
        onStopped();
      }
    } catch {
      /* not there yet, or unreadable: try again next time */
    }
  }, opts.intervalMs ?? 500);
  timer.unref?.();
  return stop;
}
