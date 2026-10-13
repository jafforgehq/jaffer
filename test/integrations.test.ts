import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { fakeClaude } from './helpers/fake-claude';
import { claudeStatus, findClaude, hooksInstalled, hooksPointAt, installHooks, removeHooks, removeMcp, setupClaude, teardownClaude } from '../src/core/integrations/claude';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  env.cleanup();
});

describe('Claude Code hooks', () => {
  it('merges into existing settings without disturbing the user\'s own hooks and removes cleanly', () => {
    const dir = path.join(env.userHome, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } }, null, 2));
    expect(installHooks('/Users/x/.jaffer/bin/jaffer', env.userHome).changed).toBe(true);
    expect(installHooks('/Users/x/.jaffer/bin/jaffer', env.userHome).changed).toBe(false); // idempotent
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0]).toEqual(mine);
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain("'/Users/x/.jaffer/bin/jaffer' hook session-start");
    expect(hooksInstalled(env.userHome)).toBe(true);
    expect(removeHooks(env.userHome).changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(after).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } });
    expect(hooksInstalled(env.userHome)).toBe(false);
  });

  const ALL_EVENTS: [string, string][] = [
    ['SessionStart', 'session-start'],
    ['Stop', 'stop'],
    ['UserPromptSubmit', 'user-prompt-submit'],
    ['PreToolUse', 'pre-tool-use'],
    ['PostToolUse', 'post-tool-use'],
    ['PostToolUseFailure', 'post-tool-use-failure'],
    ['SubagentStart', 'subagent-start'],
    ['SubagentStop', 'subagent-stop'],
    ['Notification', 'notification'],
    ['SessionEnd', 'session-end'],
    ['PreCompact', 'pre-compact'],
  ];
  const settingsFile = () => path.join(env.userHome, '.claude', 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  const oldTwoHooks = (cli: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `'${cli}' hook session-start # jaffer-managed`, timeout: 8 }] }], Stop: [{ hooks: [{ type: 'command', command: `'${cli}' hook stop # jaffer-managed`, timeout: 5 }] }] } });

  it('registers every event the companion needs, all async, keeping the user\'s own hooks', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(true);
    const s = readSettings();
    for (const [event, arg] of ALL_EVENTS) {
      const ours = (s.hooks[event] as any[]).filter((e) => e.hooks.some((h: any) => String(h.command).includes('# jaffer-managed')));
      expect(ours, event).toHaveLength(1);
      const hook = ours[0].hooks[0];
      expect(hook.command, event).toContain(`'/x/jaffer' hook ${arg} #`);
      expect(hook.async, event).toBe(true); // none may ever slow Claude Code down
    }
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [mine] });
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(false);
    expect(removeHooks(env.userHome).changed).toBe(true);
    expect(readSettings()).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } });
  });

  it('the hooks start nothing outside a Jaffer session: a shell guard sits in front of every command', () => {
    const marker = path.join(env.root, 'ran');
    const wrapper = path.join(env.root, 'wrapper');
    fs.writeFileSync(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    installHooks(wrapper, env.userHome);
    const hooks = readSettings().hooks;
    const command = (event: string): string => (hooks[event] as any[]).flatMap((e) => e.hooks).find((h: any) => String(h.command).includes('# jaffer-managed')).command;
    const run = (event: string, extra: Record<string, string>) => spawnSync('sh', ['-c', command(event)], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extra }, timeout: 10_000 });
    for (const [event] of ALL_EVENTS) {
      fs.rmSync(marker, { force: true });
      expect(run(event, {}).status, event).toBe(0);
      expect(fs.existsSync(marker), `${event} outside Jaffer must not start the Jaffer binary`).toBe(false);
      run(event, { JAFFER_SESSION: '1' });
      expect(fs.existsSync(marker), `${event} inside Jaffer must run it`).toBe(true);
    }
  });

  it('SessionStart and Stop are async and guarded like the other eight: nothing for Claude Code to wait for, nothing outside Jaffer', () => {
    installHooks('/x/jaffer', env.userHome);
    const hooks = readSettings().hooks;
    expect(hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: `[ "$JAFFER_SESSION" = 1 ] || exit 0; '/x/jaffer' hook session-start # jaffer-managed`, timeout: 5, async: true }] }]);
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: `[ "$JAFFER_SESSION" = 1 ] || exit 0; '/x/jaffer' hook stop # jaffer-managed`, timeout: 5, async: true }] }]);
  });

  it('an install with only SessionStart and Stop gets the new events, and hooksInstalled turns true', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(oldTwoHooks('/x/jaffer')));
    expect(hooksInstalled(env.userHome)).toBe(false); // the new events are missing
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(true);
    expect(hooksInstalled(env.userHome)).toBe(true);
    expect(Object.keys(readSettings().hooks).sort()).toEqual(ALL_EVENTS.map(([e]) => e).sort());
    // the two old entries are rewritten in place: one entry each, async and guarded
    for (const event of ['SessionStart', 'Stop']) {
      const ours = readSettings().hooks[event] as any[];
      expect(ours, event).toHaveLength(1);
      expect(ours[0].hooks[0], event).toMatchObject({ async: true, timeout: 5 });
      expect(ours[0].hooks[0].command, event).toMatch(/^\[ "\$JAFFER_SESSION" = 1 \] \|\| exit 0; /);
    }
  });

  it('PreCompact is the eleventh event: an install of the ten from before is not complete until it is installed again', () => {
    installHooks('/x/jaffer', env.userHome);
    const s = readSettings();
    delete s.hooks.PreCompact;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(hooksInstalled(env.userHome)).toBe(false);
    expect(hooksPointAt('/x/jaffer', env.userHome)).toBe(true); // so a daemon start of this home installs it again
    expect(installHooks('/x/jaffer', env.userHome).changed).toBe(true);
    expect(hooksInstalled(env.userHome)).toBe(true);
    expect(Object.keys(readSettings().hooks)).toHaveLength(11);
  });

  it('hooksPointAt: true only when every Jaffer hook already runs this wrapper (another Jaffer home\'s hooks are not ours to rewrite)', () => {
    expect(hooksPointAt('/x/jaffer', env.userHome)).toBe(false); // nothing installed: nothing to migrate
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(oldTwoHooks('/x/jaffer')));
    expect(hooksPointAt('/x/jaffer', env.userHome)).toBe(true);
    expect(hooksPointAt('/somewhere/else/jaffer', env.userHome)).toBe(false);
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    expect(hooksPointAt('/x/jaffer', env.userHome)).toBe(false); // only the user's own hook
  });

  it('refuses to touch a settings file it cannot parse', () => {
    const dir = path.join(env.userHome, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": "opus", // comment\n');
    const r = installHooks('/x/jaffer', env.userHome);
    expect(r.changed).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toContain('// comment');
  });
});

describe('findClaude', () => {
  it('picks the first claude on PATH, the one the user\'s own shell would run', async () => {
    const mk = (name: string) => {
      const dir = path.join(env.root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return dir;
    };
    const first = mk('first');
    const second = mk('second');
    expect(await findClaude({ HOME: env.userHome, PATH: `${first}:${second}` })).toBe(path.join(first, 'claude'));
    expect(await findClaude({ HOME: env.userHome, PATH: `${second}:${first}` })).toBe(path.join(second, 'claude'));
  });

  it.skipIf(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some((p) => fs.existsSync(p)))('a login shell that hangs in its rc files is stopped at the time limit, also one that ignores SIGTERM (as an interactive shell does), and nothing is left running', async () => {
    vi.stubEnv('HOME', env.userHome); // (the usual install places under the home: none here, so the login shell is asked)
    const shell = path.join(env.root, 'stuck-shell');
    const pidFile = path.join(env.root, 'shell.pid');
    fs.writeFileSync(shell, `#!/bin/sh\necho $$ > '${pidFile}'\ntrap '' TERM\nexec /bin/sleep 30\n`, { mode: 0o755 });
    const t0 = Date.now();
    expect(await findClaude({ HOME: env.userHome, PATH: '', SHELL: shell }, 800)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });
});

describe('connecting Claude Code', () => {
  it('setupClaude installs the hooks only and teardownClaude removes them: neither registers nor removes an MCP server', async () => {
    const fake = fakeClaude(path.join(env.root, 'bin'), { loggedIn: true });
    const cenv = { ...process.env, HOME: env.userHome, PATH: `${fake.dir}:${process.env.PATH}` };
    const up = await setupClaude('/x/jaffer', { home: env.userHome, env: cenv });
    expect(up.messages).toEqual(['Installed Jaffer’s hooks in ~/.claude/settings.json.']);
    expect(up.status).toEqual({ claudeInstalled: true, claudePath: path.join(fake.dir, 'claude'), hooks: true, settingsFile: path.join(env.userHome, '.claude', 'settings.json') });
    expect(hooksInstalled(env.userHome)).toBe(true);
    const down = await teardownClaude(env.userHome, cenv);
    expect(down.messages).toEqual(['Removed Jaffer hooks.']);
    expect(down.status.hooks).toBe(false);
    expect(await claudeStatus(env.userHome, cenv)).not.toHaveProperty('mcp');
    expect(fake.calls().filter((l) => l.startsWith('mcp'))).toEqual([]); // `claude` was not asked anything about MCP
  });

  it('removeMcp takes back the `jaffer` MCP server of earlier versions (user scope), once, when asked', async () => {
    const fake = fakeClaude(path.join(env.root, 'bin'), { loggedIn: true });
    const r = await removeMcp(path.join(fake.dir, 'claude'), { ...process.env, HOME: env.userHome });
    expect(r.ok).toBe(false); // (this stand-in knows no MCP: a `claude` that fails or has none says so, and nothing else happens)
    expect(fake.calls().map((l) => l.replace(/ HOME=.*/, ''))).toEqual(['mcp remove jaffer -s user']);
  });

  it('removeMcp runs claude with its own folder first on its PATH: a claude installed with npm is a script that starts the node next to it, and an app opened from the Finder has a short PATH', async () => {
    const dir = path.join(env.root, 'npm-bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jaffer-test-node'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 }); // (a stand-in for node: it runs the script)
    fs.writeFileSync(path.join(dir, 'claude'), `#!/usr/bin/env jaffer-test-node\necho "$*" >> '${path.join(env.root, 'npm-calls.log')}'\nexit 0\n`, { mode: 0o755 });
    const r = await removeMcp(path.join(dir, 'claude'), { HOME: env.userHome, PATH: '/usr/bin:/bin' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(env.root, 'npm-calls.log'), 'utf8')).toBe('mcp remove jaffer -s user\n');
  });
});
