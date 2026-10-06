import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClaude } from './helpers/fake-claude';
import { makeEnv, type TestEnv } from './helpers/env';
import { claudeAuth, ClaudeLogin } from '../src/core/integrations/claude-auth';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const fake = (o: { loggedIn: boolean; mode?: string }) => fakeClaude(path.join(env.root, 'bin'), o);
const userEnv = () => ({ ...process.env, HOME: env.userHome });

describe('claudeAuth', () => {
  it('says signed in when `claude auth status` reports loggedIn', async () => {
    const f = fake({ loggedIn: true });
    expect(await claudeAuth(f.bin, userEnv())).toEqual({ installed: true, loggedIn: true });
    expect(f.calls()).toEqual([`auth status --json HOME=${env.userHome}`]); // asked as the user: their HOME decides which login it sees
  });

  it('says signed out when the CLI reports loggedIn false and exits non-zero', async () => {
    const f = fake({ loggedIn: false });
    expect(await claudeAuth(f.bin, userEnv())).toEqual({ installed: true, loggedIn: false });
  });

  it('never lets the account email or organisation leave this function', async () => {
    const f = fake({ loggedIn: true });
    const res = await claudeAuth(f.bin, userEnv());
    expect(Object.keys(res).sort()).toEqual(['installed', 'loggedIn']);
    expect(JSON.stringify(res)).not.toMatch(/someone@example\.com|Example Org/);
  });

  it('counts unreadable output, a crash and a hang as signed out, without throwing', async () => {
    const f = fake({ loggedIn: true });
    for (const mode of ['garbage', 'crash']) {
      f.setMode(mode);
      expect(await claudeAuth(f.bin, userEnv())).toEqual({ installed: true, loggedIn: false });
    }
    f.setMode('hang');
    const t0 = Date.now();
    expect(await claudeAuth(f.bin, userEnv(), 300)).toEqual({ installed: true, loggedIn: false });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('reports not installed when there is no claude binary', async () => {
    expect(await claudeAuth(null, userEnv())).toEqual({ installed: false, loggedIn: false });
  });
});

describe('ClaudeLogin', () => {
  it('runs `claude auth login` as the user and ends once they have signed in', async () => {
    const f = fake({ loggedIn: false });
    const login = new ClaudeLogin(f.bin, userEnv());
    const done = login.start();
    expect(login.running).toBe(true);
    expect(await done).toEqual({ ok: true });
    expect(login.running).toBe(false);
    expect(f.calls()).toEqual([`auth login HOME=${env.userHome}`]);
    expect(await claudeAuth(f.bin, userEnv())).toEqual({ installed: true, loggedIn: true });
  });

  it('reports a failed login with the reason', async () => {
    const f = fake({ loggedIn: false, mode: 'login-fail' });
    const res = await new ClaudeLogin(f.bin, userEnv()).start();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('login failed');
  });

  it('starts one login at a time: a second start joins the first', async () => {
    const f = fake({ loggedIn: false });
    const login = new ClaudeLogin(f.bin, userEnv());
    const a = login.start();
    const b = login.start();
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
    expect(f.calls()).toHaveLength(1);
  });

  it('cancel stops a login that is waiting for the browser', async () => {
    const f = fake({ loggedIn: false, mode: 'hang' });
    const login = new ClaudeLogin(f.bin, userEnv());
    const done = login.start();
    await new Promise((r) => setTimeout(r, 150));
    login.cancel();
    const res = await done;
    expect(res).toEqual({ ok: false, message: 'cancelled' });
    expect(login.running).toBe(false);
  });

  it('gives up on a login nobody finishes', async () => {
    const f = fake({ loggedIn: false, mode: 'hang' });
    const login = new ClaudeLogin(f.bin, userEnv(), 300);
    const res = await login.start();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/timed out/i);
    expect(login.running).toBe(false);
  });
});
