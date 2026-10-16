import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchConversations, searchQuery, SEARCH_FILES } from '../src/core/claude/search';
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
afterEach(() => env.cleanup());

const uuid = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const user = (content: unknown) => JSON.stringify({ type: 'user', cwd: '/w', timestamp: new Date(T0).toISOString(), message: { role: 'user', content } });
const reply = (content: unknown) => JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: new Date(T0).toISOString(), message: { id: 'm', model: 'claude-sonnet-5-5', content } });

function write(id: string, lines: string[], mtime = T0, project = '-w'): string {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe('searchQuery: what the deep search accepts', () => {
  it('trimmed, 3 to 64 characters, no control character', () => {
    expect(searchQuery('  login bug ')).toBe('login bug');
    expect(searchQuery('abc')).toBe('abc');
    expect(searchQuery('é'.repeat(64))).toBe('é'.repeat(64));
    for (const bad of ['', 'ab', '  ab  ', 'x'.repeat(65), 'a\nbc', 'ab\x00c', 'abc\x1b', 5, null, undefined, {}, ['abc']]) expect(searchQuery(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('searchConversations (1.4.0, opt-in): which conversations hold a text, and how often; ids and counts only', () => {
  it('finds the text in user and assistant message text, in any case, counts each conversation (newest first), and returns nothing else', async () => {
    write(uuid(1), [user('The Login bug again'), reply([{ type: 'text', text: 'login: fixed. LOGIN works' }])], T0 + 1000);
    write(uuid(2), [user([{ type: 'text', text: 'about the login page' }])], T0 + 2000, '-other');
    write(uuid(3), [user('nothing here')], T0 + 3000);
    const r = await searchConversations(claudeDir, 'LOGIN');
    expect(r).toEqual({ hits: [{ id: uuid(2), count: 1 }, { id: uuid(1), count: 3 }], partial: false });
  });

  it('a planted secret in a tool call, a tool result, thinking, a summary or a field outside the message never matches; no returned field holds message text', async () => {
    write(uuid(1), [
      reply([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo PLANTED-SECRET' } }]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'PLANTED-SECRET in the output' }]),
      user([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'PLANTED-SECRET nested' }] }]),
      reply([{ type: 'thinking', thinking: 'PLANTED-SECRET thought' }]),
      JSON.stringify({ type: 'summary', summary: 'PLANTED-SECRET summary' }),
      JSON.stringify({ type: 'user', cwd: '/PLANTED-SECRET', toolUseResult: { stdout: 'PLANTED-SECRET' }, message: { role: 'user', content: 'plain words' } }),
      JSON.stringify({ type: 'system', content: 'PLANTED-SECRET system' }),
      // (fix round) what is not the person's or Claude's words: `!` command output, a slash command's output, a hook's text, meta, compaction and sidechain lines
      user('<bash-stdout>PLANTED-SECRET from a ! command</bash-stdout>'),
      user([{ type: 'text', text: '<local-command-stdout>PLANTED-SECRET</local-command-stdout>' }]),
      user('  <user-prompt-submit-hook>PLANTED-SECRET</user-prompt-submit-hook>'),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'PLANTED-SECRET meta' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'PLANTED-SECRET compacted' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'PLANTED-SECRET from a subagent' }] } }),
    ]);
    expect(await searchConversations(claudeDir, 'planted-secret')).toEqual({ hits: [], partial: false });
    write(uuid(2), [user('a PLANTED-SECRET said in words')]);
    const r = await searchConversations(claudeDir, 'planted-secret');
    expect(r).toEqual({ hits: [{ id: uuid(2), count: 1 }], partial: false });
    expect(JSON.stringify(r)).not.toMatch(/said|words|PLANTED/);
  });

  it('a plain substring (no pattern), at most 99 a conversation; quotes and backslashes match as typed', async () => {
    write(uuid(1), [user('a.c abc a.c'), user('x'.repeat(10) + ' aaa'.repeat(500)), user('say "hi\\there" now')]);
    expect((await searchConversations(claudeDir, 'a.c')).hits).toEqual([{ id: uuid(1), count: 2 }]);
    expect((await searchConversations(claudeDir, ' aaa')).hits).toEqual([{ id: uuid(1), count: 99 }]);
    expect((await searchConversations(claudeDir, '"hi\\there"')).hits).toEqual([{ id: uuid(1), count: 1 }]);
    expect((await searchConversations(claudeDir, 'a.*c')).hits).toEqual([]);
  });

  it('reads at most 2 MB of a transcript: its head and its tail, never the middle', async () => {
    const big = 'filler '.repeat(200_000); // ~1.4 MB a line
    write(uuid(1), [user('needle-head'), user(big), user('needle-middle'), user(big), user('needle-tail')]);
    expect(await searchConversations(claudeDir, 'needle-head')).toEqual({ hits: [{ id: uuid(1), count: 1 }], partial: false });
    expect(await searchConversations(claudeDir, 'needle-tail')).toEqual({ hits: [{ id: uuid(1), count: 1 }], partial: false });
    expect(await searchConversations(claudeDir, 'needle-middle')).toEqual({ hits: [], partial: false });
  });

  it('looks at the 200 newest transcripts only', async () => {
    for (let i = 0; i < SEARCH_FILES + 5; i++) write(`${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, [user('common words')], T0 + i * 1000);
    const r = await searchConversations(claudeDir, 'common');
    expect(r.hits).toHaveLength(SEARCH_FILES);
    expect(r.hits.some((h) => h.id.startsWith('00000000') || h.id.startsWith('00000004'))).toBe(false);
  }, 30_000);

  it('a newer search cancels an older one still scanning: the older gives nothing, partial', async () => {
    for (let i = 0; i < 20; i++) write(`${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, [user('cancel words')], T0 + i);
    const older = searchConversations(claudeDir, 'cancel');
    const newer = searchConversations(claudeDir, 'cancel');
    expect(await older).toEqual({ hits: [], partial: true });
    expect((await newer).hits).toHaveLength(20);
  });

  it('stops at its time budget and says so (partial)', async () => {
    write(uuid(1), [user('words')]);
    write(uuid(2), [user('words')]);
    expect(await searchConversations(claudeDir, 'words', { budgetMs: 0 })).toEqual({ hits: [], partial: true });
  });

  it('is confined like the list: no linked transcript or folder, no subagent transcript, nothing that is not <uuid>.jsonl', async () => {
    const outside = path.join(env.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${uuid(1)}.jsonl`), user('confined-word') + '\n');
    fs.mkdirSync(path.join(projects, '-w'), { recursive: true });
    fs.symlinkSync(path.join(outside, `${uuid(1)}.jsonl`), path.join(projects, '-w', `${uuid(2)}.jsonl`));
    fs.symlinkSync(outside, path.join(projects, '-linked'));
    fs.mkdirSync(path.join(projects, '-w', uuid(3), 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projects, '-w', uuid(3), 'subagents', `${uuid(4)}.jsonl`), user('confined-word') + '\n');
    fs.writeFileSync(path.join(projects, '-w', 'notes.jsonl'), user('confined-word') + '\n');
    expect(await searchConversations(claudeDir, 'confined-word')).toEqual({ hits: [], partial: false });
    expect(await searchConversations(path.join(env.root, 'nowhere'), 'confined-word')).toEqual({ hits: [], partial: false });
  });

  it('is quick on hostile lines: a single line of 1 MB and of 8 MB, broken JSON, a 1 MB text full of near matches', async () => {
    write(uuid(1), ['a'.repeat(1024 * 1024)]);
    write(uuid(2), ['{"type":"user","message":{"content":"' + 'ab'.repeat(4 * 1024 * 1024)]);
    write(uuid(3), [user('aaab'.repeat(256 * 1024))]);
    write(uuid(4), ['{' + '"aab":'.repeat(150_000)]);
    const t = Date.now();
    const r = await searchConversations(claudeDir, 'aab');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r).toEqual({ hits: [{ id: uuid(3), count: 99 }], partial: false });
  });

  it('refuses a query it does not accept', async () => {
    await expect(searchConversations(claudeDir, 'ab')).rejects.toThrow(/3 to 64/);
    await expect(searchConversations(claudeDir, 'abc\n')).resolves.toEqual({ hits: [], partial: false }); // (trimmed)
    await expect(searchConversations(claudeDir, 'a\x07bc')).rejects.toThrow(/3 to 64/);
  });

  it('changes nothing on disk and keeps nothing', async () => {
    write(uuid(1), [user('stay put')]);
    const list = () => fs.readdirSync(claudeDir, { recursive: true }).sort();
    const before = list();
    await searchConversations(claudeDir, 'stay');
    expect(list()).toEqual(before);
  });
});
