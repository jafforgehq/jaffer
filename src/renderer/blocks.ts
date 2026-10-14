import { unescapeOsc } from '../shared/osc';
import { SAVE_TEXT_MAX } from '../shared/save-text';

/**
 * Command blocks, from the shell marks the integration scripts send (no xterm here: the terminal view feeds the marks and keeps the
 * markers). Per command: A (a prompt starts), E;<escaped command>, C (its output starts), D;<exit> (it ended). There is no 133;B.
 * Lines are buffer lines; the view keeps them current from its markers (scrollback that is trimmed moves them).
 */
export interface Block {
  id: number;
  promptLine: number;
  outputStart?: number;
  /** The last line of the output (below `outputStart` when there was none). */
  outputEnd?: number;
  cmd?: string;
  /** null: the command ended but its exit is not known. */
  exit?: number | null;
  startedAt?: number;
  endedAt?: number;
}

export type MarkKind = 'A' | 'C' | 'D' | 'E';

export const MAX_BLOCKS = 500;

export class BlockModel {
  private list: Block[] = [];
  private nextId = 1;

  /** `onDrop`: a block the model let go of by itself (an empty prompt replaced, the oldest past the cap), so the view frees its markers. */
  constructor(private readonly onDrop: (b: Block) => void = () => undefined) {}

  /** One mark at a buffer line (for D: the last line of the output). Returns the block it changed, if any. Malformed marks are ignored. */
  onMark(kind: MarkKind, payload: string, line: number, now: number): Block | undefined {
    if (!Number.isInteger(line) || line < 0) return undefined;
    const last = this.list[this.list.length - 1];
    if (kind === 'A') {
      if (last && last.outputStart === undefined) this.drop(this.list.length - 1); // a prompt where nothing ran (Enter on an empty line)
      else if (last && last.endedAt === undefined) Object.assign(last, { outputEnd: line - 1, exit: null, endedAt: now }); // its D was lost
      const b: Block = { id: this.nextId++, promptLine: line };
      this.list.push(b);
      while (this.list.length > MAX_BLOCKS) this.drop(0);
      return b;
    }
    if (!last || last.endedAt !== undefined) return undefined;
    if (kind === 'E') {
      if (last.cmd !== undefined) return undefined;
      last.cmd = unescapeOsc(payload);
    } else if (kind === 'C') {
      if (last.outputStart !== undefined) return undefined;
      Object.assign(last, { outputStart: line, startedAt: now });
    } else {
      if (last.outputStart === undefined) return undefined;
      const exit = /^-?\d+$/.test(payload) ? Number.parseInt(payload, 10) : null;
      Object.assign(last, { outputEnd: line, exit, endedAt: now });
    }
    return last;
  }

  blocks(): readonly Block[] {
    return this.list;
  }

  /** The block `line` belongs to: from its prompt to the end of its output (a block still running or waiting reaches the end). */
  blockAt(line: number): Block | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]!;
      if (b.promptLine > line) continue;
      const end = b.endedAt === undefined ? Infinity : Math.max(b.promptLine, b.outputEnd ?? b.promptLine);
      return line <= end ? b : undefined;
    }
    return undefined;
  }

  remove(id: number): void {
    this.list = this.list.filter((b) => b.id !== id);
  }

  reset(): void {
    this.list = [];
    this.nextId = 1;
  }

  private drop(i: number): void {
    const [b] = this.list.splice(i, 1);
    if (b) this.onDrop(b);
  }
}

/** `text` in a fenced code block for Markdown, `$ <cmd>` as its first line when given; the fence is longer than any backtick run in either. */
export function fenceText(text: string, cmd?: string): string {
  let longest = 0;
  for (const s of [text, cmd ?? '']) {
    let run = 0;
    for (let i = 0; i < s.length; i++) {
      run = s.charCodeAt(i) === 96 ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${cmd ? `$ ${cmd}\n` : ''}${text.slice(0, end)}\n${fence}`;
}

interface BufferLike {
  readonly length: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

const CUT_NOTE = '\n[cut at 32 MB]';

/** A block's output as plain text (a wrapped line joined back into one, trailing empty lines left out), at most `SAVE_TEXT_MAX` characters. */
export function blockOutputText(buffer: BufferLike, block: Block): string {
  if (block.outputStart === undefined) return '';
  const last = Math.min(block.outputEnd ?? buffer.length - 1, buffer.length - 1);
  const parts: string[] = [];
  let size = 0;
  for (let y = block.outputStart; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const joined = buffer.getLine(y + 1)?.isWrapped && y < last; // the next line continues this one: keep its full width, no newline
    const text = line.translateToString(!joined) + (joined || y === last ? '' : '\n');
    if (size + text.length > SAVE_TEXT_MAX - CUT_NOTE.length) {
      parts.push(text.slice(0, SAVE_TEXT_MAX - CUT_NOTE.length - size), CUT_NOTE);
      return parts.join('');
    }
    parts.push(text);
    size += text.length;
  }
  const out = parts.join('');
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 10) end--;
  return out.slice(0, end);
}
