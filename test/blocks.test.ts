import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { BlockModel, MAX_BLOCKS, blockOutputText, fenceText, saveName, type Block } from '../src/renderer/blocks';
import { SAVE_TEXT_MAX, utf8Bytes } from '../src/shared/save-text';
import { COMMAND_HEAD } from '../src/shared/process-badge';

/** Feeds marks the way the shell scripts send them: A at the prompt, E and C when a command starts, D;<exit> when it ends. */
function run(m: BlockModel, at: { prompt: number; start: number; end: number }, cmd: string, exit: string, t0 = 1_000, t1 = 3_000): void {
  m.onMark('A', '', at.prompt, t0 - 500);
  m.onMark('E', cmd, at.start, t0);
  m.onMark('C', '', at.start, t0);
  m.onMark('D', exit, at.end, t1);
}

describe('BlockModel: a block per command, from the shell marks', () => {
  it('a normal command: prompt line, output range, command, exit code, start and end time', () => {
    const m = new BlockModel();
    run(m, { prompt: 4, start: 5, end: 7 }, 'ls -la', '0');
    expect(m.blocks()).toEqual([{ id: 1, promptLine: 4, outputStart: 5, outputEnd: 7, cmd: 'ls -la', exit: 0, startedAt: 1_000, endedAt: 3_000 }]);
  });

  it('the command text arrives OSC-escaped and is unescaped (backslash, semicolon, newline, ESC, BEL)', () => {
    const m = new BlockModel();
    run(m, { prompt: 0, start: 1, end: 1 }, 'echo a\\x3bb \\x5cn\\x0aecho \\x1b\\x07', '0');
    expect(m.blocks()[0]!.cmd).toBe('echo a;b \\n\necho \x1b\x07');
  });

  it('a failure keeps its exit code; a bare D (exit unknown) is null', () => {
    const m = new BlockModel();
    run(m, { prompt: 0, start: 1, end: 1 }, 'false', '1');
    run(m, { prompt: 2, start: 3, end: 3 }, 'kill -9 $$', '');
    expect(m.blocks().map((b) => b.exit)).toEqual([1, null]);
  });

  it('an empty Enter (a prompt and the next prompt, no command) leaves no block behind', () => {
    const m = new BlockModel();
    m.onMark('A', '', 0, 1);
    m.onMark('D', '', 1, 2); // precmd sends a bare D when no command ran
    m.onMark('A', '', 1, 3);
    run(m, { prompt: 2, start: 3, end: 3 }, 'pwd', '0');
    expect(m.blocks().map((b) => [b.promptLine, b.cmd])).toEqual([[2, 'pwd']]);
  });

  it('the prompt waiting for a command is a block without output yet; a running one has no end', () => {
    const m = new BlockModel();
    m.onMark('A', '', 0, 1);
    expect(m.blocks()).toEqual([{ id: 1, promptLine: 0 }]);
    m.onMark('E', 'sleep 9', 1, 2);
    m.onMark('C', '', 1, 2);
    expect(m.blocks()[0]).toMatchObject({ outputStart: 1, startedAt: 2, cmd: 'sleep 9' });
    expect(m.blocks()[0]!.endedAt).toBeUndefined();
  });

  it('marks out of order or missing: C or D without a prompt, D before C, a second C are ignored; a prompt after a lost D ends the block', () => {
    const m = new BlockModel();
    m.onMark('C', '', 0, 1); // the window attached while a command ran: its start was not seen
    m.onMark('D', '0', 3, 2);
    expect(m.blocks()).toEqual([]);
    m.onMark('A', '', 4, 3);
    m.onMark('D', '0', 4, 4); // D before C
    expect(m.blocks()[0]!.exit).toBeUndefined();
    m.onMark('E', 'make', 5, 5);
    m.onMark('C', '', 5, 5);
    m.onMark('C', '', 9, 6);
    expect(m.blocks()[0]!.outputStart).toBe(5);
    m.onMark('A', '', 12, 7); // its D never came
    expect(m.blocks()[0]).toMatchObject({ outputStart: 5, outputEnd: 11, exit: null, endedAt: 7 });
    expect(m.blocks()[1]).toMatchObject({ promptLine: 12 });
  });

  it('ignores malformed marks: a line that is not a whole number at or above 0, an exit that is not a number', () => {
    const m = new BlockModel();
    m.onMark('A', '', -1, 1);
    m.onMark('A', '', Number.NaN, 1);
    m.onMark('A', '', 1.5, 1);
    expect(m.blocks()).toEqual([]);
    run(m, { prompt: 0, start: 1, end: 1 }, 'x', 'oops');
    expect(m.blocks()[0]!.exit).toBeNull();
  });

  it('a forged command of 10 MB is kept clipped (its head, before unescaping), quickly', () => {
    const m = new BlockModel();
    m.onMark('A', '', 0, 1);
    const t0 = performance.now();
    m.onMark('E', 'x'.repeat(10 * 1024 * 1024), 1, 2);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(m.blocks()[0]!.cmd).toHaveLength(4 * COMMAND_HEAD);
  });

  it('an exit of more digits than a safe integer holds is not known (null), not Infinity', () => {
    const m = new BlockModel();
    run(m, { prompt: 0, start: 1, end: 1 }, 'x', '9'.repeat(400));
    run(m, { prompt: 2, start: 3, end: 3 }, 'y', '99999999999999999');
    expect(m.blocks().map((b) => b.exit)).toEqual([null, null]);
  });

  it('keeps the newest 500 blocks: the oldest go, and the view hears which', () => {
    const dropped: number[] = [];
    const m = new BlockModel((b) => dropped.push(b.id));
    for (let i = 0; i < MAX_BLOCKS + 3; i++) run(m, { prompt: i * 3, start: i * 3 + 1, end: i * 3 + 1 }, `echo ${i}`, '0');
    expect(m.blocks()).toHaveLength(MAX_BLOCKS);
    expect(m.blocks()[0]!.cmd).toBe('echo 3');
    expect(dropped).toEqual([1, 2, 3]);
  });

  it('blockAt: the block a line belongs to (prompt to end of output; a running block reaches the end)', () => {
    const m = new BlockModel();
    run(m, { prompt: 0, start: 1, end: 3 }, 'a', '0');
    run(m, { prompt: 4, start: 5, end: 4 }, 'true', '0'); // no output
    m.onMark('A', '', 5, 9);
    m.onMark('E', 'tail -f log', 6, 9);
    m.onMark('C', '', 6, 9);
    expect(m.blockAt(0)?.cmd).toBe('a');
    expect(m.blockAt(3)?.cmd).toBe('a');
    expect(m.blockAt(4)?.cmd).toBe('true');
    expect(m.blockAt(500)?.cmd).toBe('tail -f log');
    expect(new BlockModel().blockAt(3)).toBeUndefined();
  });

  it('remove and reset: a block whose prompt left the scrollback goes; after a reset blocks start again from 1', () => {
    const dropped: number[] = [];
    const m = new BlockModel((b) => dropped.push(b.id));
    run(m, { prompt: 0, start: 1, end: 1 }, 'a', '0');
    run(m, { prompt: 2, start: 3, end: 3 }, 'b', '0');
    m.remove(1);
    expect(m.blocks().map((b) => b.cmd)).toEqual(['b']);
    m.reset();
    expect(m.blocks()).toEqual([]);
    expect(dropped).toEqual([]); // remove and reset are the view's own doing: it is not told again
    run(m, { prompt: 0, start: 1, end: 1 }, 'c', '0');
    expect(m.blocks()[0]!.id).toBe(1);
  });
});

describe('saveName: the file name "Save output…" suggests', () => {
  const b = (cmd?: string): Block => ({ id: 1, promptLine: 0, cmd });
  it('the command\'s first word (its last path part), then -output.txt', () => {
    expect(saveName(b('make -j8 test'))).toBe('make-output.txt');
    expect(saveName(b('/usr/bin/git log'))).toBe('git-output.txt');
  });

  it('leading NAME=value words are skipped: a password in the environment never reaches the name', () => {
    expect(saveName(b('PGPASSWORD=hunter2 psql -h db'))).toBe('psql-output.txt');
    expect(saveName(b('A=1 B=two   npm run build'))).toBe('npm-output.txt');
    expect(saveName(b('TOKEN=abc'))).toBe('output.txt');
    expect(saveName(b('./x=y run'))).toBe('output.txt'); // a word with = in it is never used
  });

  it('nothing to go by, or a sensitive command: output.txt', () => {
    expect(saveName(b())).toBe('output.txt');
    expect(saveName(b('   '))).toBe('output.txt');
    expect(saveName(b('cat ~/.ssh/id_rsa'))).toBe('output.txt');
  });
});

describe('fenceText: copy as Markdown', () => {
  it('fences the text, with the command as the first line when there is one', () => {
    expect(fenceText('hi\n')).toBe('```\nhi\n```');
    expect(fenceText('total 0\n\n', 'ls -la')).toBe('```\n$ ls -la\ntotal 0\n```');
  });

  it('a fence longer than any run of backticks in the text or the command', () => {
    expect(fenceText('a ```` b', 'echo `x`')).toBe('`````\n$ echo `x`\na ```` b\n`````');
  });

  it('is quick on 8 MB of backticks and newlines', () => {
    const big = '`\n'.repeat(4 * 1024 * 1024);
    const t0 = performance.now();
    expect(fenceText(big).startsWith('```\n')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('blockOutputText: a block\'s output from the buffer', () => {
  const term = async (text: string, cols = 10): Promise<Terminal> => {
    const t = new Terminal({ cols, rows: 5, scrollback: 100, allowProposedApi: true });
    await new Promise<void>((r) => t.write(text, r));
    return t;
  };
  const block = (outputStart: number, outputEnd?: number): Block => ({ id: 1, promptLine: outputStart - 1, outputStart, outputEnd });

  it('the lines of the output, a wrapped line joined back into one, trailing empty lines left out', async () => {
    const t = await term('$ cmd\r\nshort\r\n0123456789abcdef\r\nend\r\n\r\n\r\n$ ');
    expect(blockOutputText(t.buffer.active, block(1, 6))).toBe('short\n0123456789abcdef\nend');
  });

  it('a running block reads to the end of the buffer; no output is empty', async () => {
    const t = await term('$ tail\r\none\r\ntwo');
    expect(blockOutputText(t.buffer.active, block(1))).toBe('one\ntwo');
    expect(blockOutputText(t.buffer.active, block(1, 0))).toBe('');
  });

  it('counts bytes, not characters: 32 MB of UTF-8 at most', () => {
    const line = { isWrapped: false, translateToString: () => 'é€😀'.repeat(100_000) };
    const buf = { length: 200, getLine: () => line };
    const out = blockOutputText(buf, block(0, 199));
    expect(utf8Bytes(out)).toBeLessThanOrEqual(SAVE_TEXT_MAX);
    expect(utf8Bytes(out)).toBeGreaterThan(SAVE_TEXT_MAX - 16);
    expect(out).toMatch(/\n\[cut at 32 MB\]$/);
    expect(out).not.toMatch(/[\uD800-\uDBFF]\n\[cut/); // no half of a pair left at the cut
  });

  it('stops at 32 MB and says so', () => {
    const line = { isWrapped: false, translateToString: () => 'x'.repeat(1024 * 1024) };
    const buf = { length: 100, getLine: () => line };
    const out = blockOutputText(buf, block(0, 99));
    expect(out.length).toBeLessThanOrEqual(SAVE_TEXT_MAX);
    expect(out).toMatch(/\n\[cut at 32 MB\]$/);
  });
});
