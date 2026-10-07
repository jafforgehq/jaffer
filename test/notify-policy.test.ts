import { describe, expect, it } from 'vitest';
import { commandNotification, needsYouNotification } from '../src/shared/notify-policy';
import type { ClaudeSession, ClaudeState } from '../src/core/claude/watcher';

const s = (state: ClaudeState, notice?: string, id = 's1'): ClaudeSession => ({ id, state, since: 1, subagents: [], notice });
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
