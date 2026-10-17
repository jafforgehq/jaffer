import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTurn, readTurnCost, transcriptSize } from '../src/core/claude/cost';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let claudeDir: string;
let file: string;
beforeEach(() => {
  env = makeEnv();
  claudeDir = path.join(env.userHome, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'projects', '-p'), { recursive: true });
  file = path.join(claudeDir, 'projects', '-p', 'session.jsonl');
});
afterEach(() => env.cleanup());

/** One transcript line the way Claude Code writes it: a model response with its usage. */
const reply = (id: string, output: number, model = 'claude-sonnet-5-5') => `${JSON.stringify({ type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: output } } })}\n`;
const user = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

describe('transcriptSize', () => {
  it('is where the file stands now, and 0 when there is no file or no path', async () => {
    fs.writeFileSync(file, 'abc');
    expect(await transcriptSize(file, claudeDir)).toBe(3);
    expect(await transcriptSize(path.join(path.dirname(file), 'missing.jsonl'), claudeDir)).toBe(0);
    expect(await transcriptSize(undefined, claudeDir)).toBe(0);
  });
});

describe('readTurnCost', () => {
  it('counts only what was written after the offset: an earlier conversation in the file is not this answer', async () => {
    fs.writeFileSync(file, reply('old', 9_999_999) + user('earlier question'));
    const from = await transcriptSize(file, claudeDir);
    fs.appendFileSync(file, user('new question') + reply('a1', 300));
    const turn = (await readTurnCost(file, claudeDir, from))!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(300);
  });

  it('can stop at an end offset, so the next answer starts exactly where this one ended', async () => {
    fs.writeFileSync(file, reply('a1', 100));
    const end = await transcriptSize(file, claudeDir);
    fs.appendFileSync(file, reply('a2', 700));
    expect((await readTurnCost(file, claudeDir, 0, end))!.output).toBe(100);
    expect((await readTurnCost(file, claudeDir, end))!.output).toBe(700);
    expect((await readTurnCost(file, claudeDir, 0))!.output).toBe(800);
  });

  it('has nothing to say when the file is missing, empty past the offset, or was replaced by a shorter one', async () => {
    expect(await readTurnCost(path.join(path.dirname(file), 'missing.jsonl'), claudeDir, 0)).toBeUndefined();
    fs.writeFileSync(file, reply('a1', 100));
    const size = await transcriptSize(file, claudeDir);
    expect(await readTurnCost(file, claudeDir, size)).toBeUndefined(); // nothing new
    fs.writeFileSync(file, user('a fresh, shorter file'));
    expect(await readTurnCost(file, claudeDir, size + 500)).toBeUndefined(); // the file is shorter than where the turn began
  });

  it('has nothing to say about a stretch without a model response (a prompt that was answered with an interrupt)', async () => {
    fs.writeFileSync(file, user('stop right there'));
    expect(await readTurnCost(file, claudeDir, 0)).toBeUndefined();
  });

  it('reads only the end of a very long stretch and drops the line it starts in the middle of', async () => {
    const whole = reply('a1', 111) + reply('a2', 222) + reply('a3', 333);
    fs.writeFileSync(file, whole);
    const lastTwo = reply('a2', 222).length + reply('a3', 333).length;
    // a window that starts inside a2 sees a broken a2 (skipped) and a whole a3
    const turn = (await readTurnCost(file, claudeDir, 0, Infinity, reply('a3', 333).length + 10))!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(333);
    // a window that starts exactly where a2 starts sees both
    expect((await readTurnCost(file, claudeDir, 0, Infinity, lastTwo))!.messages).toBe(2);
    // and the default window is far larger than any ordinary answer
    expect((await readTurnCost(file, claudeDir, 0))!.messages).toBe(3);
  });

  it('skips a torn last line (the answer is still being written) without losing the lines before it', async () => {
    fs.writeFileSync(file, reply('a1', 100) + '{"type":"assistant","message":{"id":"a2","usage":{"output_tok');
    const turn = (await readTurnCost(file, claudeDir, 0))!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(100);
  });

  it('keeps nothing but numbers: the result has no text of the conversation', async () => {
    fs.writeFileSync(file, user('my SECRET question') + reply('a1', 5));
    const turn = (await readTurnCost(file, claudeDir, 0))!;
    expect(JSON.stringify(turn)).not.toContain('SECRET');
    expect(Object.keys(turn).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'messages', 'model', 'output', 'usd']);
  });

  it('readTurn (1.4.0): the same read gives the context of the latest response (what it read in, and its model), numbers and the model id only', async () => {
    fs.writeFileSync(file, user('my SECRET question') + reply('a1', 5) + `${JSON.stringify({ type: 'assistant', message: { id: 'a2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'SECRET answer' }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 70_000 } } })}\n`);
    const r = await readTurn(file, claudeDir, 0);
    expect(r.context).toEqual({ tokens: 70_003, model: 'claude-opus-5-5' });
    expect(r.cost).toEqual((await readTurnCost(file, claudeDir, 0)));
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(await readTurn(path.join(path.dirname(file), 'missing.jsonl'), claudeDir, 0)).toEqual({});
  });
});

describe('the Stop reader is confined (1.4.1)', () => {
  it('reads nothing of a transcript_path outside <claudeDir>/projects, a link out of it, or a FIFO', async () => {
    const outside = path.join(env.root, 'outside.jsonl');
    fs.writeFileSync(outside, reply('a1', 100));
    expect(await transcriptSize(outside, claudeDir)).toBe(0);
    expect(await readTurnCost(outside, claudeDir, 0)).toBeUndefined();
    expect(await readTurn(outside, claudeDir, 0)).toEqual({});
    fs.symlinkSync(outside, file);
    expect(await transcriptSize(file, claudeDir)).toBe(0);
    expect(await readTurnCost(file, claudeDir, 0)).toBeUndefined();
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
    expect(await transcriptSize(file, claudeDir)).toBe(0);
    expect(await readTurnCost(file, claudeDir, 0)).toBeUndefined();
  });
});
