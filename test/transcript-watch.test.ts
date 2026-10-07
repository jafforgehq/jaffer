import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { watchRejection } from '../src/core/claude/transcript-watch';

let env: TestEnv;
let stops: (() => void)[] = [];
beforeEach(() => {
  env = makeEnv();
  stops = [];
});
afterEach(() => {
  for (const s of stops) s();
  env.cleanup();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const watch = (file: string, cb: () => void) => {
  const stop = watchRejection(file, cb, { intervalMs: 20 });
  stops.push(stop);
  return stop;
};

describe('watchRejection', () => {
  it('fires once when a rejection line is appended after it started, and ignores lines that were already there', async () => {
    const file = path.join(env.root, 't.jsonl');
    fs.writeFileSync(file, '{"toolUseResult":"User rejected tool use"}\n');
    let n = 0;
    watch(file, () => n++);
    await sleep(100);
    expect(n).toBe(0);
    fs.appendFileSync(file, '{"type":"user","message":"hello"}\n');
    await sleep(100);
    expect(n).toBe(0);
    fs.appendFileSync(file, '{"type":"user","toolUseResult":"User rejected tool use"}\n');
    await sleep(150);
    expect(n).toBe(1);
    fs.appendFileSync(file, '{"x":"[Request interrupted by user for tool use]"}\n');
    await sleep(150);
    expect(n).toBe(1); // once: the caller starts a new watch if it needs another
  });

  it('also recognises the interruption line', async () => {
    const file = path.join(env.root, 't.jsonl');
    fs.writeFileSync(file, '');
    let n = 0;
    watch(file, () => n++);
    fs.appendFileSync(file, '{"content":"[Request interrupted by user for tool use]"}\n');
    await sleep(150);
    expect(n).toBe(1);
  });

  it('does nothing after the stop function, and survives a file that does not exist yet', async () => {
    const file = path.join(env.root, 'later.jsonl');
    let n = 0;
    const stop = watch(file, () => n++);
    await sleep(60); // no file: no throw, no call
    stop();
    fs.writeFileSync(file, '{"toolUseResult":"User rejected tool use"}\n');
    await sleep(100);
    expect(n).toBe(0);
  });
});
