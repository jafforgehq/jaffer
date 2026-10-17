import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_CHUNK_BYTES, LIVE_TAIL_MAX, LIVE_TICK_BYTES, LiveCost, MAX_READ, readTurn } from '../src/core/claude/cost';
import { summarizeTurn } from '../src/shared/claude-cost';
import { makeEnv, type TestEnv } from './helpers/env';

/** (1.4.1) The live cost figure reads only what was appended since its last read, and comes to the same numbers as a full read. */

let env: TestEnv;
let file: string;
beforeEach(() => {
  env = makeEnv();
  file = path.join(env.root, 'session.jsonl');
});
afterEach(() => env.cleanup());

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-unknown-9'];
/** A planted transcript: prompts and tool output with multi-byte text, responses streamed over several lines (one id, growing counts), subagents, Claude Code's own notices, torn JSON. */
function transcript(r: () => number, lines: number): string {
  let out = '';
  let id = 0;
  for (let i = 0; i < lines; i++) {
    const k = r();
    if (k < 0.25) out += `${JSON.stringify({ type: 'user', message: { role: 'user', content: `héllo 日本語 🎉 ${'ü'.repeat(Math.floor(r() * 40))}` } })}\n`;
    else if (k < 0.3) out += `{"type":"assistant","message":{"usage":{"output_tokens":5}, torn\n`;
    else if (k < 0.33) out += `${JSON.stringify({ type: 'assistant', message: { id: `syn${i}`, model: '<synthetic>', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`;
    else if (k < 0.36) out += `${JSON.stringify({ type: 'assistant', message: { model: MODELS[0], usage: { input_tokens: 3, output_tokens: 4 } } })}\n`; // no id: a response of its own
    else {
      if (r() < 0.5) id++;
      const usage = { input_tokens: Math.floor(r() * 1000), output_tokens: Math.floor(r() * 5000), cache_read_input_tokens: Math.floor(r() * 50_000), cache_creation: { ephemeral_5m_input_tokens: Math.floor(r() * 100), ephemeral_1h_input_tokens: Math.floor(r() * 100) } };
      out += `${JSON.stringify({ type: 'assistant', isSidechain: r() < 0.1, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), message: { id: `msg_${id}`, model: MODELS[Math.floor(r() * MODELS.length)], content: [{ type: 'text', text: `ça va ✓ ${'€'.repeat(Math.floor(r() * 20))}` }], usage } })}\n`;
    }
  }
  return out;
}

/** Reads until nothing new is left; the last result. */
async function drain(live: LiveCost, id: string, f: string, start: number) {
  let last: Awaited<ReturnType<LiveCost['read']>>;
  for (let i = 0; i < 1_000_000; i++) {
    const r = await live.read(id, f, start);
    if (r === undefined) return last;
    last = r;
  }
  throw new Error('never drained');
}

describe('LiveCost', () => {
  it('comes to exactly the numbers of a full read, whatever pieces the transcript is written and read in (mid-line, mid-character; 200 seeds)', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const before = transcript(r, 3); // an earlier answer in the same file is not this one
      const turn = transcript(r, 10 + Math.floor(r() * 40));
      const bytes = Buffer.from(before + turn);
      const start = Buffer.byteLength(before);
      fs.writeFileSync(file, bytes.subarray(0, start));
      const live = new LiveCost({ tickBytes: 64 + Math.floor(r() * 4096), chunkBytes: 1 + Math.floor(r() * 256) });
      let at = start;
      let last: Awaited<ReturnType<LiveCost['read']>>;
      while (at < bytes.length) {
        const next = Math.min(bytes.length, at + 1 + Math.floor(r() * 300));
        fs.appendFileSync(file, bytes.subarray(at, next));
        at = next;
        last = (await live.read('s', file, start)) ?? last;
      }
      last = (await drain(live, 's', file, start)) ?? last;
      const full = summarizeTurn(turn.split('\n'));
      expect(last ?? {}, `seed ${seed}`).toEqual(full);
      expect(live.offset('s')).toBe(bytes.length);
    }
  }, 60_000);

  it('a response streamed over lines read in different ticks counts once (by its id, the largest numbers win)', async () => {
    const line = (output: number) => `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: output } } })}\n`;
    fs.writeFileSync(file, line(5));
    const live = new LiveCost();
    expect((await live.read('s', file, 0))!.cost).toMatchObject({ output: 5, messages: 1 });
    fs.appendFileSync(file, line(300));
    expect((await live.read('s', file, 0))!.cost).toMatchObject({ input: 10, output: 300, messages: 1 });
    fs.appendFileSync(file, line(300));
    expect((await live.read('s', file, 0))!.cost).toMatchObject({ output: 300, messages: 1 });
  });

  it('nothing new to say about an unchanged, empty or missing file', async () => {
    const live = new LiveCost();
    expect(await live.read('s', path.join(env.root, 'missing.jsonl'), 0)).toBeUndefined();
    fs.writeFileSync(file, '');
    expect(await live.read('s', file, 0)).toBeUndefined();
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2 } } })}\n`);
    expect((await live.read('s', file, 0))!.cost!.output).toBe(2);
    expect(await live.read('s', file, 0)).toBeUndefined(); // unchanged
    expect(await live.read('s', file, fs.statSync(file).size + 10)).toBeUndefined(); // a turn that begins past the end
  });

  it('a transcript that shrank below where it was read to starts again from the turn’s start', async () => {
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: output } } })}\n`;
    const before = reply('old', 1_000_000);
    fs.writeFileSync(file, before + reply('a', 100) + reply('b', 200) + reply('c', 300));
    const live = new LiveCost();
    const start = Buffer.byteLength(before);
    expect((await live.read('s', file, start))!.cost!.output).toBe(600);
    fs.truncateSync(file, start); // (fs.truncate keeps the inode: only the size says it)
    fs.appendFileSync(file, reply('x', 7));
    expect((await drain(live, 's', file, start))!.cost).toMatchObject({ output: 7, messages: 1 });
  });

  it('a transcript replaced by another file (a new inode) starts again from the turn’s start, even when it is longer', async () => {
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: output } } })}\n`;
    fs.writeFileSync(file, reply('a', 100));
    const live = new LiveCost();
    expect((await live.read('s', file, 0))!.cost!.output).toBe(100);
    const other = path.join(env.root, 'other.jsonl');
    fs.writeFileSync(other, reply('x', 1) + reply('y', 2) + reply('z', 4));
    fs.renameSync(other, file);
    expect((await drain(live, 's', file, 0))!.cost).toMatchObject({ output: 7, messages: 3 });
  });

  it('a new turn (another start) or a forgotten session starts from nothing', async () => {
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: output } } })}\n`;
    fs.writeFileSync(file, reply('a', 100));
    const live = new LiveCost();
    await live.read('s', file, 0);
    const end = fs.statSync(file).size;
    fs.appendFileSync(file, reply('b', 5));
    expect((await live.read('s', file, end))!.cost).toMatchObject({ output: 5, messages: 1 });
    live.keep([]);
    expect(live.offset('s')).toBeUndefined();
    expect((await live.read('s', file, 0))!.cost).toMatchObject({ output: 105, messages: 2 });
  });

  it('reads at most 4 MB a tick, and what is left on the next ticks', async () => {
    expect(LIVE_TICK_BYTES).toBe(4 * 1024 * 1024);
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })}\n`;
    fs.writeFileSync(file, line.repeat(Math.ceil((10 * 1024 * 1024) / line.length)));
    const size = fs.statSync(file).size;
    const live = new LiveCost();
    let prev = 0;
    for (let i = 0; i < 3; i++) {
      await live.read('s', file, 0);
      const now = live.offset('s')!;
      expect(now - prev).toBeLessThanOrEqual(LIVE_TICK_BYTES);
      expect(now).toBeGreaterThan(prev);
      prev = now;
    }
    expect(prev).toBe(size);
  });

  it('a line without a newline is never kept past 8 MB: it is dropped up to its newline, and the lines after it count again', async () => {
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: output } } })}\n`;
    fs.writeFileSync(file, `${reply('a', 100)}{"type":"user","message":{"content":"`);
    const live = new LiveCost();
    expect((await live.read('s', file, 0))!.cost).toMatchObject({ output: 100, messages: 1 });
    // a 30 MB line, written while the answer goes on, not ended yet
    const piece = 'z'.repeat(1024 * 1024);
    let tail = 0;
    for (let i = 0; i < 30; i++) {
      fs.appendFileSync(file, piece);
      expect((await drain(live, 's', file, 0))!.cost).toMatchObject({ output: 100, messages: 1 });
      tail = Math.max(tail, live.tailLength('s')!);
    }
    expect(tail).toBeLessThanOrEqual(LIVE_TAIL_MAX);
    expect(LIVE_TAIL_MAX).toBe(8 * 1024 * 1024);
    fs.appendFileSync(file, `"}}\n${reply('b', 5)}`);
    const r = await drain(live, 's', file, 0);
    expect(r!.cost).toMatchObject({ output: 105, messages: 2 });
    expect(live.tailLength('s')).toBe(0);
  }, 60_000);

  it('one budget of 4 MB a tick is shared by every session', async () => {
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })}\n`;
    fs.writeFileSync(file, line.repeat(Math.ceil((3 * 1024 * 1024) / line.length)));
    const live = new LiveCost();
    const ids = ['a', 'b', 'c', 'd'];
    const total = () => ids.reduce((n, id) => n + (live.offset(id) ?? 0), 0);
    let prev = 0;
    for (let tick = 0; tick < 3; tick++) {
      const budget = { left: LIVE_TICK_BYTES };
      for (const id of ids) await live.read(id, file, 0, budget);
      expect(total() - prev).toBeLessThanOrEqual(LIVE_TICK_BYTES);
      expect(total()).toBeGreaterThan(prev);
      prev = total();
    }
  });

  it('4 sessions on a transcript longer than 24 MB: a turn of the event loop after every piece read, and the numbers are those of the full (bounded) read', async () => {
    const r = rng(7);
    let body = '';
    while (body.length < 2 * 1024 * 1024) body += transcript(r, 200) + `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ö'.repeat(5000) }] } })}\n`;
    const big = path.join(env.root, 'big.jsonl');
    const fd = fs.openSync(big, 'w');
    while (fs.fstatSync(fd).size < MAX_READ + 1024 * 1024) fs.writeSync(fd, body);
    fs.closeSync(fd);
    const size = fs.statSync(big).size;
    const ids = ['a', 'b', 'c', 'd'];
    const live = new LiveCost();
    // a beat on every turn of the event loop: between two beats at most one piece may have been read (and parsed). (A session's first
    // offset is where its read begins, of a turn this long only its end: that is not read yet)
    const seen = new Map<string, number>();
    let beats = 0;
    let most = 0;
    let bytes = 0;
    let gap = 0;
    let at = performance.now();
    let on = true;
    const beat = () => {
      if (!on) return;
      let delta = 0;
      for (const id of ids) {
        const o = live.offset(id);
        if (o === undefined) continue;
        if (seen.has(id)) delta += o - seen.get(id)!;
        seen.set(id, o);
      }
      most = Math.max(most, delta);
      bytes += delta;
      gap = Math.max(gap, performance.now() - at);
      at = performance.now();
      beats++;
      setImmediate(beat);
    };
    setImmediate(beat);
    const results = new Map<string, Awaited<ReturnType<LiveCost['read']>>>();
    try {
      // the daemon's ticks: every session in turn with one shared budget (as `readLive` does), until each has read everything
      for (let more = true, ticks = 0; more; ticks++) {
        expect(ticks).toBeLessThan(40); // (4 × 24 MB at 4 MB a tick)
        more = false;
        const budget = { left: LIVE_TICK_BYTES };
        for (const id of ids) {
          const x = await live.read(id, big, 0, budget);
          if (!x) continue;
          more = true;
          results.set(id, x);
        }
      }
    } finally {
      on = false;
    }
    const full = readTurn(big, 0, size);
    expect(results.size).toBe(4);
    for (const x of results.values()) expect(x).toEqual(full);
    expect(most).toBeLessThanOrEqual(LIVE_CHUNK_BYTES);
    expect(bytes).toBeGreaterThan(4 * (MAX_READ - LIVE_CHUNK_BYTES));
    expect(beats).toBeGreaterThanOrEqual(Math.floor(bytes / LIVE_CHUNK_BYTES));
    expect(gap).toBeLessThan(500); // (a loose bound: a Mac busy with other work can pause any process)
  }, 60_000);
});

describe('no sync file call on the live path', () => {
  const slice = (file: string, from: string, end: string) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const i = src.indexOf(from);
    expect(i, `${from} in ${file}`).toBeGreaterThanOrEqual(0);
    return src.slice(i, src.indexOf(end, i));
  };
  it('LiveCost (cost.ts) and readLive (service.ts) use no readSync, readFileSync, statSync, openSync or other sync call', () => {
    for (const code of [slice('src/core/claude/cost.ts', 'export class LiveCost', '\n}\n'), slice('src/daemon/service.ts', 'private async readLive', '\n  }\n')]) {
      expect(code.length).toBeGreaterThan(100);
      expect(code).not.toMatch(/\w+Sync\s*\(/);
      expect(code).not.toMatch(/\b(transcriptSize|readTurn|readTurnCost)\s*\(/); // (the sync readers of Stop's path)
    }
  });
});
