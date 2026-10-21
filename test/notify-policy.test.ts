import { describe, expect, it } from 'vitest';
import { commandNotification, needsYouNotification, shouldBounce, terminalWhere } from '../src/shared/notify-policy';
import type { ClaudeSession, ClaudeState } from '../src/core/claude/watcher';

const s = (state: ClaudeState, notice?: string, id = 's1'): ClaudeSession => ({ id, state, since: 1, startedAt: 1, turns: 0, calls: [], counts: {}, files: [], subagents: [], notice });
const away = { windowFocused: false, lastTerminalNotifyAt: 0, now: 100_000 };

describe('needsYouNotification', () => {
  it('fires when a session newly enters needs-you, with the notice as the body', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'Claude needs your permission to use Bash')], away)).toEqual({ title: 'Claude needs you', body: 'Claude needs your permission to use Bash' });
  });

  it('counts a session that first shows up already waiting, and falls back to a plain body without a notice', () => {
    expect(needsYouNotification([], [s('needs-you')], away)).toEqual({ title: 'Claude needs you', body: 'Claude is waiting for your permission.' });
  });

  it('does not fire again while the session stays in needs-you', () => {
    expect(needsYouNotification([s('needs-you', 'x')], [s('needs-you', 'x')], away)).toBeNull();
  });

  it('does not fire for other transitions', () => {
    for (const next of ['working', 'idle', 'ended'] as const) expect(needsYouNotification([s('idle')], [s(next)], away)).toBeNull();
  });

  it('does not fire while the window is focused: the panel is in front of the user', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, windowFocused: true })).toBeNull();
  });

  it('does not fire if a terminal notification was shown in the previous 10 seconds (one alert per event)', () => {
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, lastTerminalNotifyAt: 100_000 - 9_999 })).toBeNull();
    expect(needsYouNotification([s('working')], [s('needs-you', 'x')], { ...away, lastTerminalNotifyAt: 100_000 - 10_000 })).not.toBeNull();
  });
});

describe('commandNotification', () => {
  const away = { windowFocused: false };
  const run = (cmd: string, over: Partial<{ exit: number | null; durMs: number }> = {}) => commandNotification({ cmd, exit: 0, durMs: 45_000, ...over }, away);

  it('says a long command finished or failed, how long it took, and what it was', () => {
    expect(run('npm run build')).toEqual({ title: 'Command finished', body: 'npm run build — 45s' });
    expect(run('npm test', { exit: 2, durMs: 130_000 })).toEqual({ title: 'Command failed (exit 2)', body: 'npm test — 2 min' });
    expect(run('make', { exit: null, durMs: 90_000 })!.title).toBe('Command failed (exit null)');
    expect(run('sleep 31', { durMs: 89_000 })!.body).toBe('sleep 31 — 89s');
  });

  it('a forged command of 8 MB: only its head is read, quickly and without throwing, and a sensitive one is still hidden', () => {
    const t0 = performance.now();
    const n = run('echo ' + 'x'.repeat(8 * 1024 * 1024))!;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(n.body).toMatch(/^echo x+ — 45s$/);
    expect(run('cat ~/.ssh/id_rsa ' + 'y'.repeat(8 * 1024 * 1024))!.body).toBe('A command — 45s');
  });

  it('stays quiet for a short command, while the window is in front, or for an empty line', () => {
    expect(run('ls', { durMs: 29_999 })).toBeNull();
    expect(commandNotification({ cmd: 'npm run build', exit: 0, durMs: 60_000 }, { windowFocused: true })).toBeNull();
    expect(run('   ')).toBeNull();
  });

  it('never puts a secret in Notification Center: it is redacted, and a sensitive command is not named at all', () => {
    const token = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const redacted = run(`curl -H "Authorization: Bearer ${token}" https://api.example.com`)!;
    expect(redacted.body).not.toContain('sk-ant');
    expect(redacted.body).toContain('curl');
    for (const secret of ['cat ~/.ssh/id_rsa', ' echo typed-with-a-leading-space', 'aws configure', 'ssh-keygen -t ed25519']) {
      const n = run(secret)!;
      expect(n.body, secret).toBe('A command — 45s');
    }
    for (const withPassword of ['mysql -u root -pHunter2 -e "select 1"', 'sshpass -p Hunter2 ssh me@host', 'curl -u alice:Hunter2 https://x.example.com']) {
      expect(run(withPassword)!.body, withPassword).not.toContain('Hunter2');
    }
  });

  it('keeps the body short and on one line', () => {
    const n = run(`echo ${'x'.repeat(500)}\nsecond line`)!;
    expect(n.body.length).toBeLessThanOrEqual(120 + ' — 45s'.length);
    expect(n.body).not.toContain('\n');
  });
});

describe('shouldBounce: the Dock bounces for a bell at most once in five seconds', () => {
  it('bounces the first time, then not within five seconds', () => {
    expect(shouldBounce(100_000, 0)).toBe(true);
    expect(shouldBounce(100_000, 96_000)).toBe(false);
    expect(shouldBounce(100_000, 95_000)).toBe(true);
  });
  it('a clock that went backwards waits', () => {
    expect(shouldBounce(1_000, 50_000)).toBe(false);
  });
});

describe('terminalWhere: which terminal a notification is about', () => {
  const folders = new Map([['main', '/Users/me/code/api'], ['p2', '/Users/me/code/web/'], ['p3', '/']]);
  it('names nothing with one terminal, or for a pane id that is not one', () => {
    expect(terminalWhere('main', folders, 1)).toBe('');
    expect(terminalWhere(undefined, folders, 2)).toBe('');
    expect(terminalWhere('../x', folders, 2)).toBe('');
    expect(terminalWhere('a b', folders, 2)).toBe('');
  });
  it('is the folder name with several terminals, another terminal when there is none', () => {
    expect(terminalWhere('main', folders, 2)).toBe('api');
    expect(terminalWhere('p2', folders, 2)).toBe('web');
    expect(terminalWhere('p3', folders, 2)).toBe('another terminal');
    expect(terminalWhere('p4', folders, 2)).toBe('another terminal');
  });
  it('keeps a hostile folder name short and clean', () => {
    const w = terminalWhere('main', new Map([['main', '/x/ab\u202ecd\n\u0007ef\u200bgh' + 'z'.repeat(5000)]]), 2);
    expect(w.length).toBeLessThanOrEqual(40);
    expect(w).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(w.startsWith('abcdefgh')).toBe(true);
  });
  it('cuts by characters, never in the middle of an emoji', () => {
    const w = terminalWhere('main', new Map([['main', '/x/' + '😀'.repeat(60)]]), 2);
    expect([...w]).toHaveLength(40);
    expect(w).not.toMatch(/\p{Cs}/u); // (no lone half of a pair)
  });
  it('reads an 8 MB folder in no time', () => {
    const t = Date.now();
    expect(terminalWhere('main', new Map([['main', '/a/' + 'b'.repeat(8_000_000)]]), 2).length).toBeLessThanOrEqual(40);
    expect(terminalWhere('main', new Map([['main', 'a/'.repeat(4_000_000)]]), 2).length).toBeLessThanOrEqual(40);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe('needsYouNotification with a terminal name', () => {
  it('prefixes the body with it; without a name, or when it is empty, nothing changes', () => {
    const where = (x: ClaudeSession) => (x.id === 's1' ? 'api' : '');
    expect(needsYouNotification([s('working')], [s('needs-you', 'Claude needs your permission to use Bash')], { ...away, where })).toEqual({ title: 'Claude needs you', body: 'api: Claude needs your permission to use Bash' });
    expect(needsYouNotification([s('working')], [s('needs-you')], { ...away, where })?.body).toBe('api: Claude is waiting for your permission.');
    expect(needsYouNotification([s('working', undefined, 's2')], [s('needs-you', 'x', 's2')], { ...away, where })?.body).toBe('x');
  });
});
