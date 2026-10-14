import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConversations } from '../src/core/claude/history';
import { isSessionId } from '../src/shared/session-id';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let claudeDir: string;
let projects: string;
beforeEach(() => {
  env = makeEnv();
  claudeDir = path.join(env.userHome, '.claude');
  projects = path.join(claudeDir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.cleanup();
});

const uuid = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Transcript lines the way Claude Code writes them (the parts this reader may look at, and plenty it must not keep). */
const summary = (text: string) => JSON.stringify({ type: 'summary', summary: text, leafUuid: 'x' });
const user = (text: string, cwd: string, at: number) => JSON.stringify({ type: 'user', cwd, sessionId: 'x', timestamp: iso(at), message: { role: 'user', content: text } });
const reply = (id: string, text: string, at: number, output = 100, model = 'claude-sonnet-5-5') =>
  JSON.stringify({ type: 'assistant', cwd: '/later/folder', timestamp: iso(at), message: { id, model, content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: output } } });

/** A transcript in a project folder, its modification time set (the list's order). */
function write(id: string, lines: string[], mtime: number, project = '-Users-me-code'): string {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe('isSessionId', () => {
  it('takes the UUIDs Claude Code names its conversations with, and nothing else', () => {
    expect(isSessionId('0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f')).toBe(true);
    expect(isSessionId('0F8B2C1E-9A7D-4C3B-8E2F-1A2B3C4D5E6F')).toBe(true);
    for (const bad of ['', 'abc', '../0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f', '0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f.jsonl', '0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f; rm -rf ~', '0f8b2c1e9a7d4c3b8e2f1a2b3c4d5e6f', 'zf8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f', ' 0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f', '0f8b2c1e-9a7d-4c3b-8e2f-1a2b3c4d5e6f\n'])
      expect(isSessionId(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('listConversations', () => {
  it('lists the conversations newest first: id, the folder from the first lines, first and last timestamps, how long it ran', async () => {
    write(uuid(1), [summary('old one'), user('hello', '/Users/me/code', T0), reply('m1', 'hi', T0 + 60_000)], T0 + 60_000);
    write(uuid(2), [user('next', '/Users/me/other', T0 + 3_600_000), reply('m2', 'ok', T0 + 3_660_000)], T0 + 3_700_000, '-Users-me-other');
    write(uuid(3), [user('middle', '/Users/me/code', T0 + 1000), reply('m3', 'ok', T0 + 2000)], T0 + 1_800_000);
    const items = await listConversations({ claudeDir });
    expect(items.map((c) => c.id)).toEqual([uuid(2), uuid(3), uuid(1)]);
    expect(items[0]).toEqual({ id: uuid(2), cwd: '/Users/me/other', startedAt: T0 + 3_600_000, endedAt: T0 + 3_660_000, durMs: 60_000 });
    expect(items[2]).toMatchObject({ id: uuid(1), cwd: '/Users/me/code', startedAt: T0, endedAt: T0 + 60_000, durMs: 60_000 });
  });

  it('keeps to the limit, newest first', async () => {
    for (let i = 1; i <= 6; i++) write(uuid(i), [user('q', '/a', T0 + i)], T0 + i * 1000);
    expect((await listConversations({ claudeDir, limit: 2 })).map((c) => c.id)).toEqual([uuid(6), uuid(5)]);
  });

  it('a transcript without timestamps ends when the file was last written, and has no duration', async () => {
    write(uuid(1), [summary('nothing dated')], T0);
    expect(await listConversations({ claudeDir })).toEqual([{ id: uuid(1), endedAt: T0 }]);
  });

  it('reads only the head and the tail: a big middle is not read, and the first and last timestamps come from the ends', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => user('x'.repeat(1000), '/middle', T0 - 1_000_000 + i)); // ~450 KB, beyond both 64 KB windows
    write(uuid(1), [user('first', '/Users/me/code', T0), ...filler, reply('m1', 'last', T0 + 90_000)], T0 + 90_000);
    const [c] = await listConversations({ claudeDir });
    expect(c).toMatchObject({ cwd: '/Users/me/code', startedAt: T0, endedAt: T0 + 90_000, durMs: 90_000 });
  });

  it('ignores what is not a transcript: other files, names that are not session ids, folders, links (also a link that leads out of the projects folder)', async () => {
    write(uuid(1), [user('real', '/Users/me/code', T0)], T0);
    const dir = path.join(projects, '-Users-me-code');
    fs.writeFileSync(path.join(dir, `${uuid(2)}.txt`), user('wrong kind', '/x', T0) + '\n');
    fs.writeFileSync(path.join(dir, 'notes.jsonl'), user('not an id', '/x', T0) + '\n');
    fs.mkdirSync(path.join(dir, `${uuid(3)}.jsonl`));
    fs.mkdirSync(path.join(dir, uuid(4), 'subagents'), { recursive: true }); // Claude Code's subagent transcripts live in a folder of their own
    fs.writeFileSync(path.join(dir, uuid(4), 'subagents', `${uuid(5)}.jsonl`), user('sub', '/x', T0) + '\n');
    fs.writeFileSync(path.join(projects, `${uuid(6)}.jsonl`), user('loose in the projects folder', '/x', T0) + '\n');
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${uuid(7)}.jsonl`), user('outside', '/x', T0) + '\n');
    fs.symlinkSync(path.join(outside, `${uuid(7)}.jsonl`), path.join(dir, `${uuid(7)}.jsonl`));
    fs.symlinkSync(outside, path.join(projects, '-linked-project'));
    fs.symlinkSync(path.join(dir, `${uuid(1)}.jsonl`), path.join(dir, `${uuid(8)}.jsonl`)); // even a link that stays inside
    expect((await listConversations({ claudeDir })).map((c) => c.id)).toEqual([uuid(1)]);
  });

  it('takes the folder only from a line\'s own `cwd`, a plain absolute path', async () => {
    const nested = JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { content: [{ type: 'tool_use', input: { cwd: '/from/a/tool' } }] } });
    write(uuid(1), [nested, user('q', '/Users/me/code', T0 + 1)], T0);
    write(uuid(2), [user('q', 'relative/path', T0), user('q', '/bad\u001b]0;title\u0007', T0)], T0 + 1000);
    const items = await listConversations({ claudeDir });
    expect(items.find((c) => c.id === uuid(1))!.cwd).toBe('/Users/me/code');
    expect(items.find((c) => c.id === uuid(2))!.cwd).toBeUndefined();
  });

  it('keeps nothing of what was said: no prompt, reply, tool input or summary reaches the result', async () => {
    const tool = JSON.stringify({ type: 'assistant', cwd: '/Users/me/code', timestamp: iso(T0 + 5), message: { id: 't1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo SECRET-TOOL-INPUT' } }], usage: { input_tokens: 1, output_tokens: 1 } } });
    write(uuid(1), [summary('SECRET-SUMMARY'), user('SECRET-PROMPT', '/Users/me/code', T0), tool, reply('m1', 'SECRET-REPLY', T0 + 10)], T0);
    const items = await listConversations({ claudeDir, withCost: true });
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(['cwd', 'durMs', 'endedAt', 'id', 'startedAt', 'usd']);
    const json = JSON.stringify(items);
    for (const word of ['SECRET', 'Bash', 'summary', 'claude-sonnet', 'message']) expect(json).not.toContain(word);
  });

  it('adds the cost only when asked, and only for the 30 newest', async () => {
    for (let i = 1; i <= 32; i++) write(uuid(i), [user('q', '/a', T0), reply(`m${i}`, 'a', T0 + 1, 1_000_000)], T0 + i * 1000);
    const plain = await listConversations({ claudeDir });
    expect(plain.some((c) => 'usd' in c)).toBe(false);
    const priced = await listConversations({ claudeDir, withCost: true });
    expect(priced).toHaveLength(32);
    expect(priced.slice(0, 30).every((c) => c.usd !== undefined && Math.abs(c.usd - (10 * 2 + 1_000_000 * 10) / 1e6) < 1e-9)).toBe(true);
    expect(priced.slice(30).some((c) => 'usd' in c)).toBe(false);
  });

  it('a model without a known price, a transcript without a response and one over 24 MB get no cost', async () => {
    write(uuid(1), [user('q', '/a', T0), reply('m1', 'a', T0 + 1, 100, 'some-other-model')], T0 + 1000);
    write(uuid(2), [user('q', '/a', T0)], T0 + 2000);
    const big = write(uuid(3), [user('q', '/a', T0), reply('m3', 'a', T0 + 1)], T0 + 3000);
    fs.appendFileSync(big, `${user('y'.repeat(24 * 1024 * 1024), '/a', T0 + 2)}\n`);
    fs.utimesSync(big, (T0 + 3000) / 1000, (T0 + 3000) / 1000);
    const items = await listConversations({ claudeDir, withCost: true });
    expect(items.map((c) => c.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    for (const c of items) expect('usd' in c, c.id).toBe(false);
  });

  it('is quick on lines of 8 MB (a pasted file, a long tool result): a line cut by a window is skipped, not parsed', async () => {
    const huge = 'z'.repeat(8 * 1024 * 1024);
    write(uuid(1), [user(huge, '/a', T0)], T0); // one line, larger than both windows
    write(uuid(2), [user('q', '/b', T0), user(huge, '/b', T0 + 5), reply('m2', 'a', T0 + 9)], T0 + 1000);
    fs.writeFileSync(path.join(projects, '-Users-me-code', `${uuid(3)}.jsonl`), `{"cwd":"/c","timestamp":"${huge}`); // never ends
    fs.utimesSync(path.join(projects, '-Users-me-code', `${uuid(3)}.jsonl`), (T0 + 2000) / 1000, (T0 + 2000) / 1000);
    const t0 = performance.now();
    const items = await listConversations({ claudeDir });
    expect(performance.now() - t0).toBeLessThan(1000); // a few milliseconds in practice; generous for CI
    expect(items).toEqual([
      { id: uuid(3), endedAt: T0 + 2000 },
      { id: uuid(2), cwd: '/b', startedAt: T0, endedAt: T0 + 9, durMs: 9 },
      { id: uuid(1), endedAt: T0 },
    ]);
  });

  it('is an empty list when there is no projects folder (Claude Code never ran here)', async () => {
    expect(await listConversations({ claudeDir: path.join(env.root, 'nowhere') })).toEqual([]);
  });

  it('reads asynchronously: nothing blocks the daemon, which also relays the terminal', async () => {
    write(uuid(1), [user('q', '/a', T0), reply('m1', 'a', T0 + 1)], T0);
    const sync = (['readFileSync', 'readSync', 'openSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'existsSync'] as const).map((name) => vi.spyOn(fs, name));
    let ticked = false;
    setImmediate(() => (ticked = true));
    const pending = listConversations({ claudeDir, withCost: true });
    expect(pending).toBeInstanceOf(Promise);
    const items = await pending;
    expect(items).toHaveLength(1);
    expect(ticked).toBe(true);
    for (const spy of sync) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });
});
