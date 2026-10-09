import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResumeStore } from '../src/core/claude/resume';
import { endSessionCalls, endsConversation, isPrintMode, isSessionId, resumeCommand } from '../src/shared/claude-resume';
import { AUTO_RESUME } from '../src/shared/keep-running';
import { isClaudeCommand } from '../src/shared/process-badge';
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

describe('ResumeStore: the times of automatic resume attempts', () => {
  const file = () => path.join(env.root, 'session', 'claude.json');
  const OTHER = '0c7e2d63-4b4f-4e1f-8a5b-7a1a9d3a7b22';
  const open = () => new ResumeStore(file(), () => now);
  const withPoint = (s: ResumeStore) => s.note({ id: ID, cwd: env.userHome });

  it('remembers the times of the attempts for the conversation, and no others', () => {
    const s = open();
    withPoint(s);
    expect(s.attempts(ID)).toEqual([]);
    s.recordAttempt(ID);
    now += 1000;
    s.recordAttempt(ID);
    now += 1000;
    s.recordAttempt(ID);
    expect(s.attempts(ID)).toEqual([now - 2000, now - 1000, now]);
    expect(s.attempts(OTHER)).toEqual([]);
  });

  it('counts only the attempts within the window (ten minutes)', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt(ID);
    const first = now;
    now += 5 * 60_000;
    s.recordAttempt(ID);
    now = first + AUTO_RESUME.windowMs - 1;
    expect(s.attempts(ID)).toHaveLength(2);
    now = first + AUTO_RESUME.windowMs + 1;
    expect(s.attempts(ID)).toEqual([first + 5 * 60_000]);
    now += 10 * 60_000;
    expect(s.attempts(ID)).toEqual([]);
  });

  it('survives a restart: the next daemon reads the same attempts from the same file', () => {
    const a = open();
    withPoint(a);
    a.recordAttempt(ID);
    now += 1000;
    a.recordAttempt(ID);
    const b = open();
    expect(b.attempts(ID)).toEqual([now - 1000, now]);
    expect(b.offer({ shellCwd: env.userHome, active: false, busy: false, enabled: true })?.id).toBe(ID); // the point is as it was
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('keeps them through the "still going" notes of the same conversation and through a flush', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt(ID);
    now += 40_000;
    withPoint(s); // written again (more than half a minute): the attempts are written with it
    expect(open().attempts(ID)).toEqual([now - 40_000]);
    s.flush();
    expect(open().attempts(ID)).toEqual([now - 40_000]);
  });

  it('keeps them for one conversation only: the last one named replaces the other\'s', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt(ID);
    s.recordAttempt(OTHER);
    expect(s.attempts(ID)).toEqual([]);
    expect(s.attempts(OTHER)).toEqual([now]);
    expect(open().attempts(OTHER)).toEqual([now]);
    expect(open().attempts(ID)).toEqual([]);
  });

  it('are only in memory while there is no point (the file is the point\'s), and are written once there is one', () => {
    const s = open();
    s.recordAttempt(ID);
    expect(s.attempts(ID)).toEqual([now]);
    expect(fs.existsSync(file())).toBe(false);
    withPoint(s);
    expect(open().attempts(ID)).toEqual([now]);
  });

  it('can be cleared, on disk too', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt(ID);
    s.recordAttempt(ID);
    s.clearAttempts(OTHER); // not this one: nothing happens
    expect(s.attempts(ID)).toHaveLength(2);
    s.clearAttempts(ID);
    expect(s.attempts(ID)).toEqual([]);
    expect(open().attempts(ID)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).not.toHaveProperty('attempts');
  });

  it('is gone with the point: forget() of the only point removes the file, attempts and all', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt(ID);
    s.forget(ID);
    expect(fs.existsSync(file())).toBe(false);
    expect(s.attempts(ID)).toEqual([]);
    expect(open().attempts(ID)).toEqual([]);
  });

  it('ignores an id that is not a session id', () => {
    const s = open();
    withPoint(s);
    s.recordAttempt('abc; rm -rf /');
    expect(s.attempts('abc; rm -rf /')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).not.toHaveProperty('attempts');
  });

  it('ignores an attempts block that is bad or missing, and keeps the point', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const point = { id: ID, cwd: env.userHome, at: now };
    const blocks: unknown[] = [
      undefined,
      'nope',
      null,
      [],
      { id: ID },
      { id: ID, at: 'x' },
      { id: ID, at: { 0: now } },
      { id: ID, at: [now, 'x'] },
      { id: ID, at: [now, null] },
      { id: ID, at: [now, Number.POSITIVE_INFINITY] },
      { id: 'abc; rm -rf /', at: [now] },
      { id: 7, at: [now] },
    ];
    for (const attempts of blocks) {
      fs.writeFileSync(file(), JSON.stringify({ version: 1, point, attempts }));
      const s = open();
      expect(s.attempts(ID), JSON.stringify(attempts)).toEqual([]);
      expect(s.offer({ shellCwd: env.userHome, active: false, busy: false, enabled: true })?.id, JSON.stringify(attempts)).toBe(ID);
    }
  });

  it('reads a good block, drops the times that no longer count, and keeps the list small', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const old = now - AUTO_RESUME.windowMs - 1;
    fs.writeFileSync(file(), JSON.stringify({ version: 1, point: { id: ID, cwd: env.userHome, at: now }, attempts: { id: ID, at: [now - 10, old, now - 20] } }));
    const s = open();
    expect(s.attempts(ID)).toEqual([now - 20, now - 10]);
    for (let i = 0; i < 100; i++) s.recordAttempt(ID);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).attempts.at.length).toBeLessThanOrEqual(20);
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

describe('isPrintMode: a `claude` that answers once and exits (-p, --print) is never a conversation to resume', () => {
  it('is a command line with -p or --print among its options', () => {
    for (const c of ['claude -p hi', 'claude -p "fix the build"', 'claude --print "hi"', 'claude --model opus -p hi', 'claude -c -p "and now?"', 'FOO=1 claude -p hi', '/usr/local/bin/claude --print', 'command claude -p hi', 'claude -p hi | tee out.txt']) expect(isPrintMode(c), c).toBe(true);
  });

  it('is not an interactive Claude Code, nor -p inside the words of a prompt', () => {
    for (const c of ['claude', 'claude --resume abcdef12', 'claude -c', 'claude "explain what -p does"', "claude 'use --print here'", 'claude --model opus', 'claude --permission-mode plan', 'claude mcp list', 'echo claude -p', 'claudex -p hi']) expect(isPrintMode(c), c).toBe(false);
  });
});

describe('reading a `claude` command line that came from the terminal (untrusted text, on the daemon thread)', () => {
  it('a quoted -p is still -p (the shell removes the quotes), and -p clustered with -c (both switches) is print mode', () => {
    for (const c of ['claude "-p" hi', "claude '--print' x", 'claude -cp "and now?"', 'claude -pc', 'claude \\-p hi']) expect(isPrintMode(c), c).toBe(true);
    for (const c of ['claude "fix -p handling"', 'claude -c "a \\"-p\\" in words"', 'claude -r abcdef12', 'claude -c', "claude 'it''s -p'"]) expect(isPrintMode(c), c).toBe(false);
  });

  // Output shown in the terminal can forge the shell's marks (OSC 133/633), and with them a "command line" of any length.
  const MB = 1_000_000;
  const hostile = {
    'escaped quotes and no closing one': 'claude ' + '\\"'.repeat(MB / 2),
    'unclosed single quotes after a word': 'claude ' + "a='".repeat(MB / 3),
    'a run of backslashes': 'claude ' + '\\'.repeat(MB),
    'an unclosed double quote': 'claude -c "' + 'x '.repeat(MB / 2),
    'many short words': 'claude ' + 'a '.repeat(MB / 2) + '-p',
    'variables and no claude': 'A=1 '.repeat(MB / 4),
    'a path of slashes and no claude': '/'.repeat(MB),
    'spaces and no claude': ' '.repeat(MB),
  };
  for (const [what, line] of Object.entries(hostile)) {
    it(`stays fast on ${what} (1 MB)`, () => {
      for (const [name, fn] of [['isPrintMode', isPrintMode], ['endsConversation', endsConversation], ['isClaudeCommand', isClaudeCommand]] as const) {
        const t0 = performance.now();
        fn(line);
        expect(performance.now() - t0, `${name}: ${what}`).toBeLessThan(200); // well under that in practice; generous for CI
      }
    });
  }

  // The same helpers run on lines that are 1 MB and 8 MB long (a forged mark can carry 10 MB). Unbounded regexes over such lines are
  // slow, and past a few MB they throw RangeError (V8's backtrack stack): so every helper cuts its input to the head itself.
  const crafted: Record<string, (bytes: number) => string> = {
    'variables and no claude (a=b )': (n) => 'a=b '.repeat(n / 4),
    'a run of `command ` words': (n) => 'command '.repeat(n / 8),
    'variables, then claude (A=1 ... claude)': (n) => 'A=1 '.repeat(n / 4) + 'claude',
    'variables that end in a newline and a tab (a=\\n\\t)': (n) => 'a=\n\t'.repeat(n / 4),
  };
  for (const size of [1, 8]) {
    for (const [what, make] of Object.entries(crafted)) {
      it(`never throws and stays fast on ${what} (${size} MB)`, () => {
        const line = make(size * MB);
        for (const [name, fn] of [['isPrintMode', isPrintMode], ['endsConversation', endsConversation], ['isClaudeCommand', isClaudeCommand]] as const) {
          const t0 = performance.now();
          expect(() => fn(line), `${name}: ${what}`).not.toThrow();
          expect(performance.now() - t0, `${name}: ${what}`).toBeLessThan(500); // microseconds in practice once cut; generous for CI
        }
      });
    }
  }

  it('cutting the input to the head changes nothing for a normal line, and reads a long one by its head', () => {
    // what is in the head decides, whatever follows it
    const tail = ' x'.repeat(MB);
    expect(isClaudeCommand('claude' + tail)).toBe(true);
    expect(endsConversation('claude --version' + tail)).toBe(false);
    expect(endsConversation('claude' + tail)).toBe(true);
    expect(isPrintMode('claude -p hi' + tail)).toBe(true);
    // and a `claude` that only begins after the head is not read as one
    expect(isClaudeCommand(' '.repeat(5000) + 'claude')).toBe(false);
  });
});

describe('endSessionCalls (what Quit and End Session asks of the daemon)', () => {
  it('forgets the conversation with claude.resume.dismiss first, which a daemon from before 0.5 knows too, then ends with forgetConversation', async () => {
    const calls: [string, unknown][] = [];
    await endSessionCalls(async (m, p) => void calls.push([m, p]));
    expect(calls).toEqual([
      ['claude.resume.dismiss', {}],
      ['app.shutdown', { forgetConversation: true }],
    ]);
  });

  it('a daemon that does not know or cannot answer the first still gets the end', async () => {
    const calls: string[] = [];
    await endSessionCalls(async (m) => {
      calls.push(m);
      if (m === 'claude.resume.dismiss') throw new Error('unknown method: claude.resume.dismiss');
    });
    expect(calls).toEqual(['claude.resume.dismiss', 'app.shutdown']);
    await expect(endSessionCalls(async () => Promise.reject(new Error('gone')))).resolves.toBeUndefined(); // (the app quits either way)
  });
});
