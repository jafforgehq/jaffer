import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTurnCost, transcriptSize } from '../src/core/claude/cost';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let file: string;
beforeEach(() => {
  env = makeEnv();
  file = path.join(env.root, 'session.jsonl');
});
afterEach(() => env.cleanup());

/** One transcript line the way Claude Code writes it: a model response with its usage. */
const reply = (id: string, output: number, model = 'claude-sonnet-5-5') => `${JSON.stringify({ type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: output } } })}\n`;
const user = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

describe('transcriptSize', () => {
  it('is where the file stands now, and 0 when there is no file or no path', () => {
    fs.writeFileSync(file, 'abc');
    expect(transcriptSize(file)).toBe(3);
    expect(transcriptSize(path.join(env.root, 'missing.jsonl'))).toBe(0);
    expect(transcriptSize(undefined)).toBe(0);
  });
});

describe('readTurnCost', () => {
  it('counts only what was written after the offset: an earlier conversation in the file is not this answer', () => {
    fs.writeFileSync(file, reply('old', 9_999_999) + user('earlier question'));
    const from = transcriptSize(file);
    fs.appendFileSync(file, user('new question') + reply('a1', 300));
    const turn = readTurnCost(file, from)!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(300);
  });

  it('can stop at an end offset, so the next answer starts exactly where this one ended', () => {
    fs.writeFileSync(file, reply('a1', 100));
    const end = transcriptSize(file);
    fs.appendFileSync(file, reply('a2', 700));
    expect(readTurnCost(file, 0, end)!.output).toBe(100);
    expect(readTurnCost(file, end)!.output).toBe(700);
    expect(readTurnCost(file, 0)!.output).toBe(800);
  });

  it('has nothing to say when the file is missing, empty past the offset, or was replaced by a shorter one', () => {
    expect(readTurnCost(path.join(env.root, 'missing.jsonl'), 0)).toBeUndefined();
    fs.writeFileSync(file, reply('a1', 100));
    const size = transcriptSize(file);
    expect(readTurnCost(file, size)).toBeUndefined(); // nothing new
    fs.writeFileSync(file, user('a fresh, shorter file'));
    expect(readTurnCost(file, size + 500)).toBeUndefined(); // the file is shorter than where the turn began
  });

  it('has nothing to say about a stretch without a model response (a prompt that was answered with an interrupt)', () => {
    fs.writeFileSync(file, user('stop right there'));
    expect(readTurnCost(file, 0)).toBeUndefined();
  });

  it('reads only the end of a very long stretch and drops the line it starts in the middle of', () => {
    const whole = reply('a1', 111) + reply('a2', 222) + reply('a3', 333);
    fs.writeFileSync(file, whole);
    const lastTwo = reply('a2', 222).length + reply('a3', 333).length;
    // a window that starts inside a2 sees a broken a2 (skipped) and a whole a3
    const turn = readTurnCost(file, 0, Infinity, reply('a3', 333).length + 10)!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(333);
    // a window that starts exactly where a2 starts sees both
    expect(readTurnCost(file, 0, Infinity, lastTwo)!.messages).toBe(2);
    // and the default window is far larger than any ordinary answer
    expect(readTurnCost(file, 0)!.messages).toBe(3);
  });

  it('skips a torn last line (the answer is still being written) without losing the lines before it', () => {
    fs.writeFileSync(file, reply('a1', 100) + '{"type":"assistant","message":{"id":"a2","usage":{"output_tok');
    const turn = readTurnCost(file, 0)!;
    expect(turn.messages).toBe(1);
    expect(turn.output).toBe(100);
  });

  it('keeps nothing but numbers: the result has no text of the conversation', () => {
    fs.writeFileSync(file, user('my SECRET question') + reply('a1', 5));
    const turn = readTurnCost(file, 0)!;
    expect(JSON.stringify(turn)).not.toContain('SECRET');
    expect(Object.keys(turn).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'messages', 'model', 'output', 'usd']);
  });
});
