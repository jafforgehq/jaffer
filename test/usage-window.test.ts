import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentUsage, MAX_FILES } from '../src/core/claude/usage-window';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let claudeDir: string;
let project: string;
const NOW = Date.now();
const H = 3_600_000;
let n = 0;
const uuid = () => `${String(++n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddd00001111`;

beforeEach(() => {
  env = makeEnv();
  claudeDir = path.join(env.root, 'claude');
  project = path.join(claudeDir, 'projects', '-work-app');
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => env.cleanup());

/** A response line as Claude Code writes it: its time, its model, its usage, and words that must never come out. */
const reply = (id: string, ago: number, usage: object, model = 'claude-sonnet-5-5') => `${JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - ago).toISOString(), message: { id, model, content: [{ type: 'text', text: 'SECRET-REPLY words' }], usage } })}\n`;
const user = (ago: number) => `${JSON.stringify({ type: 'user', timestamp: new Date(NOW - ago).toISOString(), message: { role: 'user', content: 'SECRET-PROMPT "usage"' } })}\n`;
const plant = (dir: string, text: string, mtimeAgo = 0) => {
  const file = path.join(dir, `${uuid()}.jsonl`);
  fs.writeFileSync(file, text);
  const t = (NOW - mtimeAgo) / 1000;
  fs.utimesSync(file, t, t);
  return file;
};

describe('recentUsage: the tokens (and estimated dollars) of the responses of the last 5 hours, across Claude Code\'s transcripts', () => {
  it('adds the responses written in the last 5 h (each once), leaves older ones out, and gives numbers only', async () => {
    plant(project, user(2 * H) + reply('m1', 2 * H, { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000 }) + reply('m1', 2 * H, { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000 }) + reply('old', 6 * H, { input_tokens: 9_999_999, output_tokens: 0 }));
    plant(project, reply('m2', 4 * H, { input_tokens: 0, output_tokens: 100_000 }), 4 * H);
    plant(project, reply('m3', 30 * 60_000, { input_tokens: 0, output_tokens: 7 }, 'claude-newest-9')); // no price: tokens only
    plant(project, reply('gone', 5.5 * H, { input_tokens: 5, output_tokens: 5 }), 5.5 * H); // the whole file is older
    const r = await recentUsage(claudeDir, NOW);
    expect(r.tokens).toBe(13_000 + 100_000 + 7);
    expect(r.usd).toBeCloseTo((1000 * 2 + 2000 * 10 + 10_000 * 0.2 + 100_000 * 10) / 1e6, 9);
    expect(r.files).toBe(3);
    expect(Object.keys(r).sort()).toEqual(['files', 'tokens', 'usd']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('no dollars when no response has a known price; nothing at all without transcripts', async () => {
    plant(project, reply('x', H, { input_tokens: 1, output_tokens: 1 }, 'claude-newest-9'));
    expect(await recentUsage(claudeDir, NOW)).toEqual({ tokens: 2, files: 1 });
    expect(await recentUsage(path.join(env.root, 'nowhere'), NOW)).toEqual({ tokens: 0, files: 0 });
  });

  it('is confined like the past conversations: no link (to a file or a folder), no subfolder (subagents), no file that is not <uuid>.jsonl', async () => {
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    const real = plant(outside, reply('o1', H, { input_tokens: 0, output_tokens: 1_000_000 }));
    fs.symlinkSync(real, path.join(project, `${uuid()}.jsonl`));
    fs.symlinkSync(outside, path.join(claudeDir, 'projects', '-linked-folder'));
    const sub = path.join(project, uuid(), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    plant(sub, reply('s1', H, { input_tokens: 0, output_tokens: 1_000_000 }));
    fs.writeFileSync(path.join(project, 'notes.jsonl'), reply('n1', H, { input_tokens: 0, output_tokens: 1_000_000 }));
    plant(project, reply('ok', H, { input_tokens: 0, output_tokens: 3 }));
    expect(await recentUsage(claudeDir, NOW)).toMatchObject({ tokens: 3, files: 1 });
  });

  it(`looks at the ${MAX_FILES} newest transcripts at most`, async () => {
    for (let i = 0; i < MAX_FILES + 5; i++) plant(project, reply(`r${i}`, H, { input_tokens: 0, output_tokens: 1 }), i * 1000);
    expect(await recentUsage(claudeDir, NOW)).toMatchObject({ tokens: MAX_FILES, files: MAX_FILES });
  });

  it('reads a file again only when it changed (size and time), and a cached file still drops what aged out', async () => {
    const file = plant(project, reply('a', 4.9 * H, { input_tokens: 0, output_tokens: 10 }) + reply('b', H, { input_tokens: 0, output_tokens: 20 }));
    expect((await recentUsage(claudeDir, NOW)).tokens).toBe(30);
    expect((await recentUsage(claudeDir, NOW + 0.2 * H)).tokens).toBe(20); // a aged out, the file unchanged
    fs.appendFileSync(file, reply('c', 0, { input_tokens: 0, output_tokens: 5 }));
    expect((await recentUsage(claudeDir, NOW)).tokens).toBe(35);
  });

  for (const mb of [1, 8]) {
    it(`a ${mb} MB line (no newline, or full of quotes) is read in bounded time`, async () => {
      plant(project, `{"type":"assistant","usage":"${'"'.repeat(mb * 1024 * 1024)}\n` + reply('k', H, { input_tokens: 0, output_tokens: 1 }));
      plant(project, `${'x'.repeat(mb * 1024 * 1024)}"usage"`);
      const t0 = performance.now();
      expect((await recentUsage(claudeDir, NOW)).tokens).toBe(1);
      expect(performance.now() - t0).toBeLessThan(mb === 1 ? 500 : 2_500);
    });
  }
});
