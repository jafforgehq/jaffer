import { StringDecoder } from 'node:string_decoder';
import { newTally, summarizeTally, summarizeTurn, tallyLines, type Tally, type TurnCost } from '../../shared/claude-cost';
import { openTranscript } from './transcript-open';

/**
 * Hooks are async, so the Stop of a session's last answer can arrive after its SessionEnd (`claude -p` ends at once): where that answer
 * began is kept this long after the end, then dropped.
 */
export const STOP_AFTER_END_GRACE_MS = 10_000;

/** A long agentic answer can run to a few megabytes of transcript; beyond this only the end of it is read. */
export const MAX_READ = 24 * 1024 * 1024;

/**
 * Where a transcript stands now, so a turn can be measured from here. 0 when it is not there (yet), or not a transcript inside
 * `<claudeDir>/projects` (1.4.1: every reader opens it through `openTranscript`).
 */
export async function transcriptSize(file: string | undefined, claudeDir: string): Promise<number> {
  const t = file ? await openTranscript(claudeDir, file) : null;
  await t?.fh.close().catch(() => undefined);
  return t?.size ?? 0;
}

/**
 * What the model responses written to the transcript between `fromOffset` and `toOffset` (the end, by default) cost: the numbers
 * in their `usage`, nothing else is kept (not the text, not the tool calls). Undefined when there is nothing to count or the file
 * is unreadable.
 */
export async function readTurnCost(file: string, claudeDir: string, fromOffset: number, toOffset: number = Infinity, maxBytes: number = MAX_READ): Promise<TurnCost | undefined> {
  return (await readTurn(file, claudeDir, fromOffset, toOffset, maxBytes)).cost;
}

/** (1.4.0) `readTurnCost`, and from the same read the context of the latest response (its input tokens and its model's id, for the context meter). */
export async function readTurn(file: string, claudeDir: string, fromOffset: number, toOffset: number = Infinity, maxBytes: number = MAX_READ): Promise<ReturnType<typeof summarizeTurn>> {
  const t = await openTranscript(claudeDir, file);
  if (!t) return {};
  try {
    const size = Math.min(t.size, toOffset);
    // a transcript shorter than where the turn began was replaced: nothing to say about it
    if (size <= fromOffset) return {};
    const from = Math.max(fromOffset, size - maxBytes);
    // a window cut short starts one byte early, to see whether it begins on a line boundary or in the middle of a line
    const cut = from > fromOffset;
    const start = cut ? from - 1 : from;
    const buf = Buffer.alloc(size - start);
    for (let at = 0; at < buf.length; ) {
      const { bytesRead } = await t.fh.read(buf, at, buf.length - at, start + at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (cut && !text.startsWith('\n')) lines.shift(); // it began inside a line: that piece is not a whole line
    return summarizeTurn(lines);
  } catch {
    return {};
  } finally {
    await t.fh.close().catch(() => undefined);
  }
}

/** (1.4.1) The live figure reads at most this much a tick (every 2 s), of all sessions' transcripts together; the rest on the next ticks. */
export const LIVE_TICK_BYTES = 4 * 1024 * 1024;
/** ... in pieces of this size, with a turn of the event loop between two: the daemon relays every terminal. */
export const LIVE_CHUNK_BYTES = 128 * 1024;
/** A line not yet ended is kept up to this long (characters); a longer one (a huge tool result) is dropped up to its newline. */
export const LIVE_TAIL_MAX = 8 * 1024 * 1024;

interface LiveState {
  file: string;
  /** Where the turn began (the session's `turnStart`). */
  start: number;
  dev: number;
  ino: number;
  /** Read up to here. */
  offset: number;
  /** The last line read so far, not yet ended by a newline; the decoder holds a character cut by a read. */
  tail: string;
  decoder: StringDecoder;
  /** Everything up to the next newline is dropped: the first read began inside a line (a turn longer than `MAX_READ`), or the line grew past `LIVE_TAIL_MAX`. */
  skip: boolean;
  tally: Tally;
}

/**
 * (1.4.1) What the answer being written has cost so far, per session, read incrementally: each read takes only the bytes appended
 * since the last one (asynchronously, at most what is left of the tick's `budget`), and only whole lines count, through the same tally as a full read
 * (`summarizeTurn`), so the numbers are the same. A transcript that shrank below where it was read, or was replaced by another file,
 * is read again from the turn's start. Only the token counts are kept (the tally), never the text. Stop's count of the whole answer is
 * still the full read (`readTurn`).
 */
export class LiveCost {
  private states = new Map<string, LiveState>();
  private claudeDir: string;
  private tickBytes: number;
  private chunkBytes: number;

  /** `claudeDir`: Claude Code's folder; only transcripts inside its `projects` are read (`openTranscript`). */
  constructor(o: { claudeDir: string; tickBytes?: number; chunkBytes?: number }) {
    this.claudeDir = o.claudeDir;
    this.tickBytes = o.tickBytes ?? LIVE_TICK_BYTES;
    this.chunkBytes = o.chunkBytes ?? LIVE_CHUNK_BYTES;
  }

  /**
   * What session `id`'s answer, begun at `start` in `file`, has cost so far; undefined when nothing new was read (or it cannot be).
   * `budget`: the bytes the tick may still read, shared by the sessions of one tick (what this read takes is taken from it).
   */
  async read(id: string, file: string, start: number, budget: { left: number } = { left: this.tickBytes }): Promise<ReturnType<typeof summarizeTurn> | undefined> {
    const fh = (await openTranscript(this.claudeDir, file))?.fh;
    if (!fh) return undefined;
    try {
      const st = await fh.stat();
      if (!st.isFile()) return undefined;
      let s = this.states.get(id);
      if (!s || s.file !== file || s.start !== start || s.dev !== st.dev || s.ino !== st.ino || st.size < s.offset) {
        // a new turn, or the transcript shrank or was replaced: from the turn's start, and of a very long one only its end (as `readTurn`)
        const from = Math.max(start, st.size - MAX_READ);
        const cut = from > start;
        s = { file, start, dev: st.dev, ino: st.ino, offset: cut ? from - 1 : from, tail: '', decoder: new StringDecoder('utf8'), skip: cut, tally: newTally() };
        this.states.set(id, s);
      }
      if (st.size <= s.offset || budget.left <= 0) return undefined;
      const end = Math.min(st.size, s.offset + budget.left);
      const buf = Buffer.alloc(Math.min(this.chunkBytes, end - s.offset));
      while (s.offset < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - s.offset), s.offset);
        if (bytesRead === 0) break;
        s.offset += bytesRead;
        budget.left -= bytesRead;
        this.add(s, s.decoder.write(buf.subarray(0, bytesRead)));
        if (s.offset < end) await new Promise((r) => setImmediate(r));
      }
      return summarizeTally(s.tally);
    } catch {
      return undefined;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private add(s: LiveState, text: string): void {
    if (s.skip) {
      const i = text.indexOf('\n');
      if (i < 0) return;
      s.skip = false;
      text = text.slice(i + 1);
    }
    const nl = text.lastIndexOf('\n');
    if (nl < 0) {
      if (s.tail.length + text.length > LIVE_TAIL_MAX) {
        // (no response line is this long: what matters is the next line)
        s.tail = '';
        s.skip = true;
      } else s.tail += text;
      return;
    }
    tallyLines((s.tail + text.slice(0, nl)).split('\n'), s.tally);
    s.tail = text.slice(nl + 1);
  }

  /** Where session `id` was read up to (tests). */
  offset(id: string): number | undefined {
    return this.states.get(id)?.offset;
  }

  /** How long the line not yet ended is, for session `id` (tests). */
  tailLength(id: string): number | undefined {
    return this.states.get(id)?.tail.length;
  }

  /** Forget every session but these. */
  keep(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of this.states.keys()) if (!keep.has(id)) this.states.delete(id);
  }
}
