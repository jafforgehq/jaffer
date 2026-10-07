import fs from 'node:fs';
import { summarizeLines, type TurnCost } from '../../shared/claude-cost';

/** A long agentic answer can run to a few megabytes of transcript; beyond this only the end of it is read. */
const MAX_READ = 24 * 1024 * 1024;

/** Where a transcript stands now, so a turn can be measured from here. 0 when it is not there (yet). */
export function transcriptSize(file: string | undefined): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * What the model responses written to the transcript between `fromOffset` and `toOffset` (the end, by default) cost: the numbers
 * in their `usage`, nothing else is kept (not the text, not the tool calls). Undefined when there is nothing to count or the file
 * is unreadable.
 */
export function readTurnCost(file: string, fromOffset: number, toOffset: number = Infinity, maxBytes: number = MAX_READ): TurnCost | undefined {
  try {
    const size = Math.min(fs.statSync(file).size, toOffset);
    // a transcript shorter than where the turn began was replaced: nothing to say about it
    if (size <= fromOffset) return undefined;
    const from = Math.max(fromOffset, size - maxBytes);
    // a window cut short starts one byte early, to see whether it begins on a line boundary or in the middle of a line
    const cut = from > fromOffset;
    const start = cut ? from - 1 : from;
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (cut && !text.startsWith('\n')) lines.shift(); // it began inside a line: that piece is not a whole line
    return summarizeLines(lines);
  } catch {
    return undefined;
  }
}
