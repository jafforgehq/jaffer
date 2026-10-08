import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResumeStore } from '../src/core/claude/resume';
import { endsConversation, isSessionId, resumeCommand } from '../src/shared/claude-resume';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let now = 1_000_000_000_000;
beforeEach(() => {
  env = makeEnv();
  now = 1_000_000_000_000;
});
afterEach(() => env.cleanup());

const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
const DAY = 86_400_000;

describe('isSessionId and resumeCommand', () => {
  it('accepts what Claude Code uses for a session id', () => {
    for (const id of [ID, 'abcdef12', 'A1_b2-c3d4e5f6', 'x'.repeat(64)]) expect(isSessionId(id), id).toBe(true);
  });

  it('refuses anything that could be more than an id once it is typed into a shell', () => {
    for (const bad of ['', 'short', 'abc; rm -rf /', 'abc def123', 'abcdef12\n', "abcdef12'", 'abcdef12`id`', '$(id)abcdefgh', 'abc/../../etc', '-rf-abcdefgh', 'x'.repeat(65), 'abcdef1\u0000', undefined, null, 42, {}]) {
      expect(isSessionId(bad as never), JSON.stringify(bad)).toBe(false);
    }
  });

  it('is the claude command, with the id and nothing else', () => {
    expect(resumeCommand(ID)).toBe(`claude --resume ${ID}`);
  });
});

describe('ResumeStore', () => {
  const file = () => path.join(env.root, 'session', 'claude.json');
  const folder = () => {
    const d = path.join(env.userHome, 'proj');
    fs.mkdirSync(d, { recursive: true });
    return fs.realpathSync(d);
  };
  const transcript = (name = `${ID}.jsonl`) => {
    const f = path.join(env.userHome, name);
    fs.writeFileSync(f, '{}\n');
    return f;
  };
  const open = () => new ResumeStore(file(), () => now);
  const ctx = (cwd: string, over: Partial<{ active: boolean; busy: boolean; enabled: boolean }> = {}) => ({ shellCwd: cwd, active: false, busy: false, enabled: true, ...over });

  it('offers the Claude Code that was running in the folder the shell is in again, when nothing runs', () => {
    const s = open();
    s.note({ id: ID, cwd: folder(), transcriptPath: transcript() });
    expect(s.offer(ctx(folder()))).toEqual({ id: ID, cwd: folder(), at: now });
  });

  it('offers nothing without a point, or a point that is not for this folder', () => {
    const s = open();
    expect(s.offer(ctx(folder()))).toBeNull();
    s.note({ id: ID, cwd: folder() });
    expect(s.offer(ctx(path.join(env.userHome, 'elsewhere')))).toBeNull();
    expect(s.offer({ ...ctx(folder()), shellCwd: undefined })).toBeNull();
  });

  it('offers nothing while Claude Code is running or the shell is busy, or when the person turned it off', () => {
    const s = open();
    s.note({ id: ID, cwd: folder() });
    expect(s.offer(ctx(folder(), { active: true }))).toBeNull();
    expect(s.offer(ctx(folder(), { busy: true }))).toBeNull();
    expect(s.offer(ctx(folder(), { enabled: false }))).toBeNull();
    expect(s.offer(ctx(folder()))).not.toBeNull();
  });

  it('offers nothing for a conversation that is old (two weeks) or whose transcript is gone', () => {
    const s = open();
    const t = transcript();
    s.note({ id: ID, cwd: folder(), transcriptPath: t });
    now += 14 * DAY - 1000;
    expect(s.offer(ctx(folder()))).not.toBeNull();
    now += 2000;
    expect(s.offer(ctx(folder()))).toBeNull();
    const fresh = open();
    fresh.note({ id: ID, cwd: folder(), transcriptPath: t });
    fs.rmSync(t);
    expect(fresh.offer(ctx(folder()))).toBeNull();
  });

  it('knows a folder by where it really is: a symlink to it, or a trailing slash, is the same folder', () => {
    const real = folder();
    const link = path.join(env.userHome, 'link-to-proj');
    fs.symlinkSync(real, link);
    const s = open();
    s.note({ id: ID, cwd: real });
    expect(s.offer(ctx(link))).not.toBeNull();
    expect(s.offer(ctx(`${real}/`))).not.toBeNull();
  });

  it('keeps one conversation, the newest, and the first folder it saw for it (Claude may wander, the conversation lives where it began)', () => {
    const s = open();
    const other = '0c7e2d63-4b4f-4e1f-8a5b-7a1a9d3a7b22';
    s.note({ id: ID, cwd: folder() });
    s.note({ id: ID, cwd: path.join(env.userHome, 'somewhere-it-went') });
    expect(s.offer(ctx(folder()))?.id).toBe(ID);
    s.note({ id: other, cwd: path.join(env.userHome, 'second') });
    expect(s.offer(ctx(folder()))).toBeNull(); // the point is the second conversation now
  });

  it('forgets a conversation that ended on purpose, only that one, or whatever it holds when not told which', () => {
    const s = open();
    s.note({ id: ID, cwd: folder() });
    s.forget('0c7e2d63-4b4f-4e1f-8a5b-7a1a9d3a7b22');
    expect(s.offer(ctx(folder()))).not.toBeNull();
    s.forget(ID);
    expect(s.offer(ctx(folder()))).toBeNull();
    expect(fs.existsSync(file())).toBe(false); // nothing left on disk either
    s.note({ id: ID, cwd: folder() });
    s.forget();
    expect(s.offer(ctx(folder()))).toBeNull();
  });

  it('survives a restart: the next daemon reads what the last one wrote, in a file only the person can read', () => {
    const a = open();
    a.note({ id: ID, cwd: folder(), transcriptPath: transcript() });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    const b = open();
    expect(b.offer(ctx(folder()))?.id).toBe(ID);
  });

  it('writes a changed point at once, and a mere "still going" at most every half minute (a hook fires on every tool call)', () => {
    const s = open();
    s.note({ id: ID, cwd: folder() });
    const first = fs.statSync(file()).mtimeMs;
    const stamp = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file(), stamp, stamp);
    now += 10_000;
    s.note({ id: ID, cwd: folder() });
    expect(fs.statSync(file()).mtimeMs).toBe(stamp.getTime()); // not rewritten
    now += 25_000;
    s.note({ id: ID, cwd: folder() });
    expect(fs.statSync(file()).mtimeMs).toBeGreaterThan(first - 1); // rewritten
    s.flush();
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).point.at).toBe(now);
  });

  it('ignores what is not a usable point: a bad id (it would be typed into a shell), a missing or relative folder, a transcript that is not a .jsonl file', () => {
    const s = open();
    s.note({ id: 'abc; rm -rf /', cwd: folder() });
    s.note({ id: ID, cwd: undefined });
    s.note({ id: ID, cwd: 'relative/dir' });
    expect(s.offer(ctx(folder()))).toBeNull();
    s.note({ id: ID, cwd: folder(), transcriptPath: '/etc/passwd' });
    expect(s.offer(ctx(folder()))?.id).toBe(ID); // the point is good, the odd transcript path is simply not kept
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file(), 'utf8')))).not.toContain('/etc/passwd');
  });

  it('starts empty from a file that is damaged or holds something else, and never keeps a bad id it finds there', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    for (const content of ['{not json', '', 'null', '{"point":{"id":"x; rm -rf /","cwd":"/tmp","at":1}}', '{"point":{"id":"' + ID + '","cwd":"relative","at":1}}', '{"point":"nope"}']) {
      fs.writeFileSync(file(), content);
      expect(new ResumeStore(file(), () => now).offer(ctx('/tmp')), content).toBeNull();
    }
  });
});

describe('a conversation that ended on purpose stays ended', () => {
  const store = () => new ResumeStore(path.join(env.home, 'resume.json'), () => now);
  const folder = () => {
    const dir = path.join(env.userHome, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const ask = (s: ResumeStore, dir: string) => s.offer({ shellCwd: dir, active: false, busy: false, enabled: true });

  it('ignores a late hook of it (the hooks after a tool call are asynchronous and can arrive after the exit), until Claude Code starts it again', () => {
    const dir = folder();
    const s = store();
    s.note({ id: ID, cwd: dir });
    s.forget(); // `claude` exited normally
    s.note({ id: ID, cwd: dir }); // a PostToolUse that was already on its way
    expect(ask(s, dir)).toBeNull();
    expect(fs.existsSync(path.join(env.home, 'resume.json'))).toBe(false);
    s.note({ id: ID, cwd: dir, starts: true }); // SessionStart: the person is back in it
    expect(ask(s, dir)?.id).toBe(ID);
  });

  it('also holds for an id that was ended before it was ever noted (SessionEnd, then a straggler)', () => {
    const dir = folder();
    const s = store();
    s.forget(ID);
    s.note({ id: ID, cwd: dir });
    expect(ask(s, dir)).toBeNull();
  });

  it('is only about that conversation: another one is noted as usual, and the list of ended ones stays small', () => {
    const dir = folder();
    const s = store();
    s.forget(ID);
    s.note({ id: 'f0f0f0f0-aaaa-bbbb-cccc-111122223333', cwd: dir });
    expect(ask(s, dir)?.id).toBe('f0f0f0f0-aaaa-bbbb-cccc-111122223333');
    for (let i = 0; i < 500; i++) s.forget(`ended-session-${i}`);
    s.note({ id: ID, cwd: dir }); // the oldest of 500 has been let go: remembering them all would grow without end
    expect(ask(s, dir)?.id).toBe(ID);
  });
});

describe('endsConversation: which `claude` commands, when they finish, mean the conversation is over', () => {
  it('is every way of running Claude Code itself', () => {
    for (const c of ['claude', 'claude --resume abcdef12', 'claude -c', 'claude "fix the build"', 'claude -p "hi"', 'FOO=1 claude', '/usr/local/bin/claude --model opus', 'command claude']) expect(endsConversation(c), c).toBe(true);
  });

  it('is not the commands that only ask or manage (they must not drop an offer that is waiting)', () => {
    for (const c of ['claude --version', 'claude -v', 'claude --help', 'claude -h', 'claude mcp list', 'claude update', 'claude doctor', 'claude config get theme', 'claude auth status', 'claude plugin list', 'claude --debug mcp list']) expect(endsConversation(c), c).toBe(false);
  });
});
