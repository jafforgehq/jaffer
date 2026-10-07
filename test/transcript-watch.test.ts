import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { isStopLine, transcriptActive, watchInterruption } from '../src/core/claude/transcript-watch';

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
  const stop = watchInterruption(file, cb, { intervalMs: 20 });
  stops.push(stop);
  return stop;
};
const userText = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const REJECTED = JSON.stringify({ type: 'user', toolUseResult: 'User rejected tool use' });

describe('isStopLine: only the transcript line Claude Code writes when the person stopped it counts', () => {
  it('recognises a declined prompt and an interruption, in the shapes the transcript uses', () => {
    expect(isStopLine(REJECTED)).toBe(true);
    expect(isStopLine(userText('[Request interrupted by user]'))).toBe(true);
    expect(isStopLine(userText('[Request interrupted by user for tool use]'))).toBe(true);
    expect(isStopLine(JSON.stringify({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }))).toBe(true);
    expect(isStopLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }] } }))).toBe(true);
  });

  it('ignores the same words anywhere else: code Claude wrote, a command that printed them, the user quoting them, garbage', () => {
    const quote = 'if (text.includes("[Request interrupted by user")) { stop(); } // and "User rejected tool use"';
    expect(isStopLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: 'a.ts', content: quote } }] } }))).toBe(false);
    expect(isStopLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `src/a.ts:12: ${quote}` }] }, toolUseResult: { stdout: quote } }))).toBe(false);
    expect(isStopLine(userText(`why does it say "[Request interrupted by user]" when I press Esc?`))).toBe(false);
    expect(isStopLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe(false); // only the person's side
    expect(isStopLine('not json [Request interrupted by user]')).toBe(false);
    expect(isStopLine('')).toBe(false);
    expect(isStopLine('{"type":"user","toolUseResult":"User rejected tool use and more"}')).toBe(false);
  });
});

describe('watchInterruption', () => {
  it('fires once when a stop line is appended after it started, and ignores lines that were already there', async () => {
    const file = path.join(env.root, 't.jsonl');
    fs.writeFileSync(file, `${REJECTED}\n`);
    let n = 0;
    watch(file, () => n++);
    await sleep(100);
    expect(n).toBe(0);
    fs.appendFileSync(file, `${userText('hello')}\n`);
    await sleep(100);
    expect(n).toBe(0);
    fs.appendFileSync(file, `${REJECTED}\n`);
    await sleep(150);
    expect(n).toBe(1);
    fs.appendFileSync(file, `${userText('[Request interrupted by user for tool use]')}\n`);
    await sleep(150);
    expect(n).toBe(1); // once: the caller starts a new watch if it needs another
  });

  it('notices the interruption line, also when it arrives in two pieces', async () => {
    const file = path.join(env.root, 't.jsonl');
    fs.writeFileSync(file, '');
    let n = 0;
    watch(file, () => n++);
    const line = userText('[Request interrupted by user]');
    fs.appendFileSync(file, line.slice(0, 30));
    await sleep(100);
    expect(n).toBe(0);
    fs.appendFileSync(file, `${line.slice(30)}\n`);
    await sleep(150);
    expect(n).toBe(1);
  });

  it('is not fooled by the words appearing in what Claude writes or runs', async () => {
    const file = path.join(env.root, 't.jsonl');
    fs.writeFileSync(file, '');
    let n = 0;
    watch(file, () => n++);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'grep -rn "[Request interrupted by user" src' } }] } })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'src/x.ts:3:const M = "[Request interrupted by user";' }] } })}\n`);
    await sleep(150);
    expect(n).toBe(0);
  });

  it('does nothing after the stop function, and survives a file that does not exist yet', async () => {
    const file = path.join(env.root, 'later.jsonl');
    let n = 0;
    const stop = watch(file, () => n++);
    await sleep(60); // no file: no throw, no call
    stop();
    fs.writeFileSync(file, `${REJECTED}\n`);
    await sleep(100);
    expect(n).toBe(0);
  });
});

describe('transcriptActive', () => {
  it('is true while the transcript was written to recently, false when it went quiet or is missing', () => {
    const file = path.join(env.root, 'active.jsonl');
    expect(transcriptActive(file, 60_000)).toBe(false);
    fs.writeFileSync(file, '{}\n');
    expect(transcriptActive(file, 60_000)).toBe(true);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);
    expect(transcriptActive(file, 5 * 60_000)).toBe(false);
    expect(transcriptActive(file, 30 * 60_000)).toBe(true);
    expect(transcriptActive(undefined, 60_000)).toBe(false);
  });
});
