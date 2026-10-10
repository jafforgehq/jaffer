import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { fakeClaude } from './helpers/fake-claude';
import { MockAnthropic } from './helpers/mock-anthropic';
import { ensureDaemon, tryConnect, type Launcher } from '../src/core/daemon-client';
import type { RpcClient } from '../src/core/rpc';
import { sleep } from '../src/shared/util';
import { findClaude } from '../src/core/integrations/claude';
import { STOP_AFTER_END_GRACE_MS } from '../src/core/claude/cost';
import type { ClaudeSession } from '../src/core/claude/watcher';

const CLAUDE = await findClaude().catch(() => null);

/**
 * Black-box tests of the shipped artifacts: the bundled daemon and CLI run as real, separate
 * processes, exactly as the app and the user's shell use them.
 */
const root = path.resolve(__dirname, '..');
let env: TestEnv;
let mock: MockAnthropic;
let launcher: Launcher;
let standIn: ReturnType<typeof standInClaude>;
const clients: RpcClient[] = [];

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=daemon'], { stdio: 'ignore' });
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=cli'], { stdio: 'ignore' });
  env = makeEnv();
  fs.writeFileSync(path.join(env.userHome, '.zshenv'), 'skip_global_compinit=1\n');
  // The session shell finds a stand-in `claude` first (the person's own startup file, read after the system's): a test here that runs
  // `claude` in the session shell gets this one, never the `claude` this machine has. (The `claude` the daemon itself asks,
  // `claude auth status`, is found on the daemon's PATH, not the shell's.)
  standIn = standInClaude(path.join(env.root, 'stand-in'));
  fs.writeFileSync(path.join(env.userHome, '.bash_profile'), `PATH='${standIn.dir}':"$PATH"\n`);
  mock = new MockAnthropic();
  const url = await mock.listen();
  launcher = {
    execPath: process.execPath,
    daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
    cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
    env: {
      HOME: env.userHome,
      SHELL: '/bin/bash',
      ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
      ANTHROPIC_BASE_URL: url,
      PS1: '$ ',
      // a `claude` the daemon itself runs (`claude auth status`): isolated profile, talks to the mock
      CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'),
      JAFFER_KEEP_ANTHROPIC_ENV: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  const c = await tryConnect(env.paths);
  await c?.call('app.shutdown', {}).catch(() => undefined);
  await sleep(300);
  await mock.close();
  env.cleanup();
});

async function connect(): Promise<RpcClient> {
  const c = await ensureDaemon(env.paths, launcher);
  clients.push(c);
  return c;
}

function collect(c: RpcClient, event: string): any[] {
  const got: any[] = [];
  c.on(event, (d) => got.push(d));
  return got;
}

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(40);
  }
}

/** The terminal's screen and scrollback as text (what a command printed is read here: the daemon does not keep it). */
async function screen(c: RpcClient): Promise<string> {
  return ((await c.call('session.snapshot', {})) as { data: string }).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

describe('jafferd + jaffer CLI (bundled, separate processes)', () => {
  it('starts, answers hello, and hosts a shell with integration', async () => {
    const c = await connect();
    const hello = await c.call('hello', { client: 'test' });
    expect(hello.protocol).toBe(1);
    const data = collect(c, 'pty.data');
    const cmds = collect(c, 'pty.command');
    const att = await c.call('session.attach', { cols: 100, rows: 30 });
    expect(att.panes[0].id).toBe('main');
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    // wait for the first prompt
    await waitUntil(async () => /\$ $/.test(((await c.call('session.snapshot', {})) as any).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trimEnd() + ' ') || true);
    await sleep(600);
    await c.call('pty.write', { data: 'echo persisted-marker-42\r' });
    await waitUntil(() => cmds.length > 0);
    expect(data.map((d) => d.data).join('')).toContain('persisted-marker-42');
    expect(cmds[0]).toMatchObject({ cmd: 'echo persisted-marker-42', exit: 0 });
  });

  it('keeps the session alive across client disconnects (single always-on session)', async () => {
    const a = await connect();
    const before = (await a.call('pane.list', {}))[0];
    a.close();
    await sleep(300);
    const b = await connect();
    const after = (await b.call('pane.list', {}))[0];
    expect(after.pid).toBe(before.pid); // same shell process: nothing was restarted
    const att = await b.call('session.attach', { cols: 100, rows: 30 });
    expect(att.snapshot.data).toContain('persisted-marker-42'); // and the screen came back
  });

  it('`jaffer config set` says so when a value is not of the right kind, instead of storing it and printing ok', async () => {
    const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });
    const bad = cli('config', 'set', 'session.stayAwake', 'off'); // the string "off", not a boolean
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/session\.stayAwake/);
    expect(bad.stdout).not.toContain('ok');
    const off = cli('config', 'set', 'appearance.animations', 'off'); // not a boolean: it must not look as if the animations were off
    expect(off.status).not.toBe(0);
    expect(JSON.parse(cli('config', 'get', 'appearance.animations').stdout)).toBe(true);
    expect(JSON.parse(cli('config', 'get', 'session.stayAwake').stdout)).toBe(true);
    const good = cli('config', 'set', 'session.stayAwake', 'false');
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(cli('config', 'get', 'session.stayAwake').stdout)).toBe(false);
    expect(cli('config', 'set', 'session.stayAwake', 'true').status).toBe(0);
    expect(cli('config', 'set', 'appearance.animations', 'true').status).toBe(0);
  });

  it('puts a working `jaffer` command on the PATH of the session shell', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await c.call('pty.write', { data: 'jaffer status\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'jaffer status'));
    const ev = cmds.find((x) => x.cmd === 'jaffer status');
    expect(ev.exit).toBe(0);
    const out = await screen(c);
    expect(out).toMatch(/daemon: running pid \d+/);
    expect(out).toMatch(/claude: .*(signed in|signed out|not installed)/); // Jaffer runs on the Claude login; there is no key to report
    expect(out).not.toMatch(/api key/i);
    expect(out).not.toMatch(/^memory:/m); // there is no memory to report either
    expect(fs.existsSync(path.join(env.paths.binDir, 'jaffer'))).toBe(true);
  });

  it('a daemon restart starts a plain shell: the home folder and a blank screen, nothing of the old one', async () => {
    const c = await connect();
    await c.call('session.attach', { cols: 100, rows: 30 });
    fs.mkdirSync(path.join(env.userHome, 'restart-dir'));
    await c.call('pty.write', { data: `cd ${path.join(env.userHome, 'restart-dir')} && echo old-screen-marker-77\r` });
    await waitUntil(async () => (await c.call('session.info', {})).cwd.endsWith('restart-dir'));
    await waitUntil(async () => (await screen(c)).includes('old-screen-marker-77'));
    await sleep(300);
    await c.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env.paths, 300)), 8000);
    clients.length = 0;
    const c2 = await connect();
    await waitUntil(async () => (await c2.call('pane.list', {}))[0]?.alive === true);
    const info = await c2.call('session.info', {});
    expect(info.cwd).toBe(fs.realpathSync(env.userHome)); // not the folder the old shell was in
    await sleep(1000);
    const text = await screen(c2);
    expect(text).not.toContain('old-screen-marker-77');
    expect(text).not.toContain('session restored');
  }, 30_000);

  it('streams heavy output in order with no gaps, and the daemon stays responsive', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    const seqs: number[] = [];
    let text = '';
    c.on('pty.data', (d) => (seqs.push(d.seq), (text += d.data)));
    const att = await c.call('session.attach', { cols: 120, rows: 30 });
    const base = att.snapshot.seq;
    await c.call('pty.write', { data: 'seq 1 120000\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'seq 1 120000'), 30_000);
    await waitUntil(() => text.includes('120000'), 10_000);
    expect(seqs.length).toBeGreaterThan(5);
    expect(seqs[0]).toBe(base + 1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1); // strictly consecutive: nothing dropped or reordered
    expect((await c.call('hello', {})).protocol).toBe(1);
    // a late joiner sees the same end state
    const late = await c.call('session.snapshot', {});
    expect(late.data).toContain('120000');
  }, 60_000);

  it('typing `exit` does not end the session: a fresh shell appears in the same folder', async () => {
    const c = await connect();
    const events = collect(c, 'session.lifecycle');
    const att = await c.call('session.attach', { cols: 100, rows: 30 });
    const before = att.panes[0];
    await c.call('pty.write', { data: 'exit\r' });
    await waitUntil(() => events.some((e) => e.lifecycle === 'restarted'), 10_000);
    await waitUntil(async () => {
      const p = (await c.call('pane.list', {}))[0];
      return p.alive && p.pid !== before.pid;
    }, 10_000);
    const info = await c.call('session.info', {});
    expect(info.cwd).toBe(before.cwd);
    // and it is a working, integrated shell again
    const cmds = collect(c, 'pty.command');
    await sleep(800);
    await c.call('pty.write', { data: 'echo alive-again\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'echo alive-again' && x.exit === 0), 10_000);
  }, 40_000);

  // A fresh shell's output counts from 1 again: a window that was attached to the old one would drop it (its seq is behind what the
  // window has seen) and keep showing the old screen. Every attached window is told to start over from the new shell's blank screen.
  it('a window attached when the shell is replaced (exit, Restart shell) is told to start over: a pty.reset with the fresh shell\'s blank screen, and its output follows on from it', async () => {
    const c = await connect();
    const log: { event: string; data: any }[] = [];
    c.on('*', (m) => log.push(m));
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    const bystander = await connect(); // connected, never attached: it is not a window showing the terminal
    const heard = collect(bystander, 'pty.reset');
    /** What a window shows that applies the last reset and every pty.data after it, and whether those followed on with no gap. */
    const afterLastReset = () => {
      const at = log.map((m) => m.event).lastIndexOf('pty.reset');
      const reset = log[at]!.data;
      const data = log.slice(at + 1).filter((m) => m.event === 'pty.data' && m.data.pane === 'main').map((m) => m.data);
      const inOrder = data.every((d, i) => d.seq === reset.snapshot.seq + 1 + i);
      // (as text: the screen's colours and modes, and the shell's own marks, left out)
      return { reset, inOrder, text: (reset.snapshot.data + data.map((d) => d.data).join('')).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]/g, '') };
    };
    const replaced = async (how: () => Promise<unknown>, marker: string) => {
      const resets = log.filter((m) => m.event === 'pty.reset').length;
      const before = (await c.call('pane.list', {}))[0];
      await c.call('pty.write', { data: `echo ${marker}\r` });
      await waitUntil(() => cmds.some((x) => x.cmd === `echo ${marker}`), 10_000);
      await how();
      await waitUntil(() => log.filter((m) => m.event === 'pty.reset').length > resets, 10_000);
      const after = (await c.call('pane.list', {}))[0];
      expect(after.pid).not.toBe(before.pid);
      const r = afterLastReset();
      expect(r.reset.pane).toBe('main');
      expect(r.reset.snapshot.data).not.toContain(marker); // the old screen is not carried over
      // the new shell works, and what it prints reaches the window after the reset, in order
      await sleep(800);
      await c.call('pty.write', { data: `echo fresh-${marker}\r` });
      await waitUntil(() => cmds.some((x) => x.cmd === `echo fresh-${marker}` && x.exit === 0), 10_000);
      await waitUntil(() => afterLastReset().text.includes(`\nfresh-${marker}`), 5_000);
      const end = afterLastReset();
      expect(end.inOrder).toBe(true);
      expect(end.text).not.toContain(`\n${marker}`);
    };
    await replaced(() => c.call('pty.write', { data: 'exit\r' }), 'replaced-by-exit-53');
    await replaced(() => c.call('session.restart', {}), 'replaced-by-restart-54');
    expect(heard).toEqual([]);
    bystander.close();
  }, 60_000);

  it('there is only one session: no client can open a second shell or close the first', async () => {
    const c = await connect();
    await expect(c.call('pane.split', {})).rejects.toThrow(/unknown method/);
    await expect(c.call('pane.close', { pane: 'main' })).rejects.toThrow(/unknown method/);
    const panes = await c.call('pane.list', {});
    expect(panes.map((p: any) => p.id)).toEqual(['main']);
  });

  it('rejects unknown methods without dropping the connection', async () => {
    const c = await connect();
    await expect(c.call('nope.nothing', {})).rejects.toThrow(/unknown method/);
    expect((await c.call('hello', {})).protocol).toBe(1);
  });

  it('has no chat: the agent and secrets requests are gone, and so is `jaffer ask`', async () => {
    const c = await connect();
    for (const m of ['agent.send', 'agent.thread', 'agent.status', 'agent.approve', 'agent.cancel', 'agent.compact', 'agent.tool', 'secrets.status', 'secrets.setAnthropicKey', 'secrets.clearAnthropicKey']) {
      await expect(c.call(m, {}), m).rejects.toThrow(/unknown method/);
    }
    const ask = spawnSync(process.execPath, [launcher.cliScript!, 'ask', 'hello'], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8' });
    expect(ask.status).not.toBe(0);
    expect(ask.stderr).toMatch(/Unknown command: ask/);
    expect(ask.stdout + ask.stderr).not.toMatch(/jaffer ask/); // not even in the help text
  });

  it('has no memory: its requests and its commands are gone, and nothing about it is in the help', async () => {
    const c = await connect();
    for (const m of ['memory.context', 'memory.recall', 'memory.remember', 'memory.forget', 'memory.list', 'memory.stats', 'memory.reflect', 'memory.log', 'memory.revert', 'ingest.now', 'setup.targets']) {
      await expect(c.call(m, {}), m).rejects.toThrow(/unknown method/);
    }
    const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });
    for (const cmd of ['remember', 'recall', 'forget', 'context', 'memory', 'mcp']) {
      const r = cli(cmd, 'x');
      expect(r.status, cmd).toBe(2);
      expect(r.stderr, cmd).toMatch(new RegExp(`Unknown command: ${cmd}`));
    }
    const help = cli('help').stdout;
    expect(help).not.toMatch(/memory|remember|recall|forget|\bmcp\b/i);
    expect(help).toMatch(/jaffer setup claude/);
  });

  // 0.6.0: no Resume button and no Restart Claude Code. A Claude that crashed or went with its shell is over; the person runs
  // `claude --resume` themselves when they want a conversation back.
  it('has no resume: its requests are gone, a shell that is restarted takes Claude with it, and nothing of the conversation is kept or typed afterwards (an old config that asks for it among them)', async () => {
    const c = await connect();
    for (const m of ['claude.resume', 'claude.resume.dismiss', 'claude.restart.plan', 'claude.restart', 'claude.autoresume.cancel', 'claude.autoresume.state']) {
      await expect(c.call(m, {}), m).rejects.toThrow(/unknown method/);
    }
    const offers = collect(c, 'claude.resume');
    const notices = collect(c, 'claude.autoresume');
    let shown = '';
    c.on('pty.data', (d) => (shown += d.data));
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    // what a 0.5.x config may still say: the offer on, and resuming by itself (0.5.0)
    await c.call('config.patch', { session: { resumeClaude: true, autoResume: true } });
    await sleep(500);
    await c.call('pty.write', { data: 'command -v claude\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'command -v claude'), 8000);
    expect(await screen(c)).toContain(path.join(standIn.dir, 'claude')); // the stand-in, not a real Claude Code
    const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
    const transcript = path.join(env.userHome, 'no-resume.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const hook = (name: string, over: object = {}) => c.call('claude.event', { session_id: ID, hook_event_name: name, cwd: fs.realpathSync(env.userHome), transcript_path: transcript, ...over });
    const allEnded = async () => (await c.call('claude.state', {})).sessions.every((x: any) => x.state === 'ended');
    // Claude Code crashes (the stand-in exits 1): the conversation is over
    await hook('SessionStart');
    await hook('UserPromptSubmit', { prompt: 'go' });
    standIn.exitWith(1);
    await c.call('pty.write', { data: 'claude\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'claude' && x.exit === 1), 8000);
    standIn.exitWith(0);
    await waitUntil(allEnded, 8000);
    // it works again, and the shell is restarted: the shell takes its Claude with it
    await hook('SessionStart');
    await hook('UserPromptSubmit', { prompt: 'go on' });
    expect((await c.call('claude.state', {})).sessions.some((x: any) => x.state === 'working')).toBe(true);
    const before = (await c.call('pane.list', {}))[0];
    await c.call('session.restart', {});
    await waitUntil(async () => {
      const p = (await c.call('pane.list', {}))[0];
      return p.alive && p.pid !== before.pid;
    }, 10_000);
    await waitUntil(allEnded, 8000);
    // past the 3 s notice and the 2 s quiet moment Restart Claude Code had: nothing was typed, offered or kept
    await sleep(5500);
    expect(shown).not.toContain('--resume');
    expect(cmds.filter((x) => x.cmd.includes('--resume'))).toEqual([]);
    expect(offers).toEqual([]);
    expect(notices).toEqual([]);
    expect(fs.existsSync(path.join(env.paths.sessionDir, 'claude.json'))).toBe(false);
  }, 40_000);
});

describe('first-run Claude sign-in (bundled daemon, fake claude)', () => {
  let env2: TestEnv;
  let fake: ReturnType<typeof fakeClaude>;
  let c: RpcClient;

  beforeAll(async () => {
    env2 = makeEnv();
    fake = fakeClaude(path.join(env2.root, 'bin'), { loggedIn: false });
    c = await ensureDaemon(env2.paths, {
      execPath: process.execPath,
      daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
      cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
      env: { HOME: env2.userHome, SHELL: '/bin/bash', PS1: '$ ', PATH: `${fake.dir}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' },
    });
  }, 30_000);

  afterAll(async () => {
    c?.close();
    const last = await tryConnect(env2.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    env2.cleanup();
  });

  it('asks `claude auth status` as the login, without an API key from the environment (a key is not a subscription)', async () => {
    await c.call('setup.claude.auth', {});
    const asked = fake.calls().filter((l) => l.startsWith('auth status'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((l) => l.endsWith(' KEY='))).toBe(true); // the daemon itself runs with ANTHROPIC_API_KEY set
  });

  it('connecting Claude Code after a plain-terminal first run clears "skipped": the person has adopted it', async () => {
    await c.call('config.patch', { claude: { skipped: true } });
    expect((await c.call('config.get', {})).claude.skipped).toBe(true);
    await c.call('setup.claude.install', { mcp: false });
    expect((await c.call('config.get', {})).claude.skipped).toBe(false);
  });

  it('connecting Claude Code installs the hooks only: no MCP server is registered, however it is asked', async () => {
    const res = await c.call('setup.claude.install', {});
    expect(res.status.hooks).toBe(true);
    expect(res.status).not.toHaveProperty('mcp');
    expect(res.messages.join('\n')).not.toMatch(/MCP/);
    const old = await c.call('setup.claude.install', { mcp: true }); // a window of an earlier version still asking for the memory tools
    expect(old.messages.join('\n')).not.toMatch(/MCP/);
    const off = await c.call('setup.claude.remove', {});
    expect(off.status.hooks).toBe(false);
    expect(fake.calls().some((l) => l.startsWith('mcp'))).toBe(false); // `claude` was never asked to add or remove one
    await c.call('setup.claude.install', {}); // (connected again, as the tests below expect)
  });

  it('reports whether Claude Code is installed and signed in, and nothing about the account', async () => {
    expect(await c.call('setup.claude.auth', {})).toEqual({ installed: true, loggedIn: false, loginRunning: false });
    fake.setLoggedIn(true);
    const auth = await c.call('setup.claude.auth', {});
    expect(auth).toMatchObject({ installed: true, loggedIn: true });
    expect(JSON.stringify(auth)).not.toMatch(/someone@example\.com|Example Org/);
  });

  it('signs in through the CLI: the login starts at once and the status flips when the user is done', async () => {
    fake.setLoggedIn(false);
    expect(await c.call('setup.claude.login', {})).toEqual({ started: true });
    await waitUntil(async () => (await c.call('setup.claude.auth', {})).loggedIn === true, 10_000);
    expect(await c.call('setup.claude.auth', {})).toMatchObject({ loggedIn: true, loginRunning: false });
    expect(fake.calls().some((l) => l.startsWith('auth login '))).toBe(true);
  });

  it('says why a login failed, and clears that when the user tries again', async () => {
    fake.setLoggedIn(false);
    fake.setMode('login-fail');
    await c.call('setup.claude.login', {});
    await waitUntil(async () => /login failed/.test((await c.call('setup.claude.auth', {})).loginError ?? ''), 10_000);
    expect(await c.call('setup.claude.auth', {})).toMatchObject({ loggedIn: false, loginRunning: false });
    fake.setMode('ok');
    await c.call('setup.claude.login', {});
    await waitUntil(async () => (await c.call('setup.claude.auth', {})).loggedIn === true, 10_000);
    expect((await c.call('setup.claude.auth', {})).loginError).toBeUndefined();
  });
});

describe('the terminal Claude, live (bundled daemon, hooks through the real jaffer CLI)', () => {
  let env3: TestEnv;
  let c: RpcClient;
  let mock3: MockAnthropic; // the model behind the real `claude` used by the last test
  const userHook = { type: 'command', command: 'echo my own hook' };
  const settings = () => path.join(env3.userHome, '.claude', 'settings.json');

  /** Run `jaffer hook <arg>` as Claude Code would, from inside (or outside) a Jaffer session. */
  const hookCli = (arg: string, payload: object, inSession = true) =>
    new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'dist/cli/jaffer.cjs'), 'hook', arg], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, HOME: env3.userHome, JAFFER_HOME: env3.home, JAFFER_SESSION: inSession ? '1' : '', JAFFER_NO_HOOKS: '' } });
      child.on('close', () => resolve());
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  const ev = (name: string, over: object = {}) => ({ session_id: 'sess-1', hook_event_name: name, cwd: '/work/app', ...over });
  const states = async () => (await c.call('claude.state', {})).sessions as ClaudeSession[];

  beforeAll(async () => {
    env3 = makeEnv();
    mock3 = new MockAnthropic();
    const mockUrl3 = await mock3.listen();
    // an install from before this feature (only the two memory hooks) next to the user's own hook
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    const old = (arg: string, timeout: number) => [{ hooks: [{ type: 'command', command: `'${env3.home}/bin/jaffer' hook ${arg} # jaffer-managed`, timeout }] }];
    fs.writeFileSync(settings(), JSON.stringify({ hooks: { SessionStart: old('session-start', 8), Stop: [...old('stop', 5), { hooks: [userHook] }] } }));
    c = await ensureDaemon(env3.paths, {
      execPath: process.execPath,
      daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
      cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
      env: {
        HOME: env3.userHome,
        SHELL: '/bin/bash',
        PS1: '$ ',
        // what the real `claude` of the last test (started from this daemon's shell) needs: a mock API and an isolated profile
        CLAUDE_CONFIG_DIR: path.join(env3.userHome, '.claude'),
        ANTHROPIC_BASE_URL: mockUrl3,
        ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
  }, 30_000);

  afterAll(async () => {
    c?.close();
    const last = await tryConnect(env3.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    await mock3.close();
    env3.cleanup();
  });

  it('starts with no session, and an install from before gets the new events without touching the user\'s own hook', async () => {
    expect(await states()).toEqual([]);
    const s = JSON.parse(fs.readFileSync(settings(), 'utf8'));
    for (const e of ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'SessionEnd']) {
      const ours = (s.hooks[e] as any[]).flatMap((x) => x.hooks).filter((h: any) => String(h.command).includes('# jaffer-managed'));
      expect(ours, e).toHaveLength(1);
      // the old SessionStart and Stop (which fed the memory, and ran for every Claude on the Mac) are now async and guarded like the rest
      expect(ours[0], e).toMatchObject({ async: true, timeout: 5 });
      expect(ours[0].command, e).toMatch(/^\[ "\$JAFFER_SESSION" = 1 \] \|\| exit 0; /);
    }
    expect(s.hooks.Stop.some((x: any) => x.hooks.some((h: any) => h.command === userHook.command))).toBe(true);
  });

  it('events sent through `jaffer hook` inside the session move claude.state working → idle, and are pushed to the app', async () => {
    const pushed = collect(c, 'claude.state');
    await hookCli('user-prompt-submit', ev('UserPromptSubmit', { prompt: 'run the tests' }));
    await hookCli('pre-tool-use', ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' }));
    await waitUntil(async () => (await states())[0]?.tool?.name === 'Bash');
    expect((await states())[0]).toMatchObject({ id: 'sess-1', state: 'working' });
    await hookCli('stop', ev('Stop', { last_assistant_message: 'done' }));
    await waitUntil(async () => (await states())[0]?.state === 'idle');
    // the push is throttled (at most one per 100 ms, the last one carries the newest state): wait for it
    await waitUntil(() => pushed.length > 0 && pushed[pushed.length - 1].sessions[0]?.state === 'idle');
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed[pushed.length - 1].sessions[0]).toMatchObject({ id: 'sess-1', state: 'idle' });
  });

  it('a hook from outside a Jaffer session changes nothing', async () => {
    const before = JSON.stringify(await states());
    await hookCli('user-prompt-submit', ev('UserPromptSubmit', { session_id: 'elsewhere', prompt: 'from another terminal' }), false);
    await sleep(300);
    expect(JSON.stringify(await states())).toBe(before);
  });

  it('a permission request is retracted when the transcript records that the user rejected it in the terminal', async () => {
    const transcript = path.join(env3.root, 'sess-2.jsonl');
    fs.writeFileSync(transcript, '{"type":"user","message":"hi"}\n');
    await c.call('claude.event', ev('PreToolUse', { session_id: 'sess-2', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_9' }));
    await c.call('claude.event', ev('Notification', { session_id: 'sess-2', transcript_path: transcript, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    expect((await states()).find((s) => s.id === 'sess-2')).toMatchObject({ state: 'needs-you', notice: 'Claude needs your permission to use Bash' });
    fs.appendFileSync(transcript, '{"type":"user","toolUseResult":"User rejected tool use"}\n');
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-2')?.state === 'idle', 5_000);
  });

  it('typing in the terminal while Claude waits takes "Needs you" back to working, and a decline is still noticed afterwards', async () => {
    const transcript = path.join(env3.root, 'sess-ans.jsonl');
    fs.writeFileSync(transcript, '{"type":"user","message":"hi"}\n');
    const base = { session_id: 'sess-ans', transcript_path: transcript };
    await c.call('claude.event', ev('PreToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_a1' }));
    await c.call('claude.event', ev('Notification', { ...base, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    expect((await states()).find((s) => s.id === 'sess-ans')?.state).toBe('needs-you');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await c.call('pty.write', { data: 'y' }); // the user answers in the terminal
    await c.call('pty.write', { data: '\x15' }); // (and the shell's line is cleared: a lone Esc here would swallow the next keystroke)
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-ans')?.state === 'working', 5_000);
    fs.appendFileSync(transcript, '{"type":"user","toolUseResult":"User rejected tool use"}\n');
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-ans')?.state === 'idle', 5_000);
  });

  it('the terminal’s own replies (focus, mouse, attribute reports) are not the person answering Claude; typing is', async () => {
    const base = { session_id: 'sess-reports' };
    await c.call('claude.event', ev('PreToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_r1' }));
    await c.call('claude.event', ev('Notification', { ...base, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    const mine = async () => (await states()).find((s) => s.id === 'sess-reports')?.state;
    expect(await mine()).toBe('needs-you');
    await c.call('session.attach', { cols: 100, rows: 30 });
    for (const report of ['\x1b[I', '\x1b[<0;12;4M', '\x1b[?1;2c', '\x1b[24;80R']) await c.call('pty.write', { data: report });
    await sleep(300);
    expect(await mine()).toBe('needs-you'); // clicking the window or a program asking the terminal a question answered nothing
    await c.call('pty.write', { data: 'y' });
    await waitUntil(async () => (await mine()) === 'working', 5_000);
    await c.call('pty.write', { data: '\x03' }); // leave the shell's input line clean for the tests that follow
    await sleep(300);
  });

  it('putting `jaffer` in ~/.local/bin replaces its own link, and refuses to overwrite a file of the person’s', async () => {
    const bin = path.join(env3.userHome, '.local', 'bin');
    const link = path.join(bin, 'jaffer');
    fs.mkdirSync(bin, { recursive: true });
    fs.rmSync(link, { force: true });
    expect((await c.call('setup.cli.install', {})).link).toBe(link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    await c.call('setup.cli.install', {}); // again: it is its own link, replaced
    fs.rmSync(link);
    fs.writeFileSync(link, '#!/bin/sh\necho mine\n');
    await expect(c.call('setup.cli.install', {})).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(link, 'utf8')).toContain('echo mine');
    fs.rmSync(link);
  });

  it('Esc while Claude works fires no Stop hook: the transcript shows it, and "Working" ends (words inside tool output do not count)', async () => {
    const transcript = path.join(env3.root, 'sess-esc.jsonl');
    fs.writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"go"}}\n');
    const base = { session_id: 'sess-esc', transcript_path: transcript };
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'build the thing' }));
    expect((await states()).find((s) => s.id === 'sess-esc')?.state).toBe('working');
    // a tool printing the very words is not the person pressing Esc
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'grep: [Request interrupted by user' }] } })}\n`);
    await sleep(1200);
    expect((await states()).find((s) => s.id === 'sess-esc')?.state).toBe('working');
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`);
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-esc')?.state === 'idle', 5_000);
  });

  it('says what each answer cost, from the token counts in the transcript, and adds them up over the session', async () => {
    const transcript = path.join(env3.root, 'sess-cost.jsonl');
    const reply = (id: string, usage: object) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'SECRET words that must not be kept' }], usage } })}\n`;
    // an earlier conversation in the same file is not part of this answer
    fs.writeFileSync(transcript, reply('old', { input_tokens: 1_000_000, output_tokens: 0 }));
    const base = { session_id: 'sess-cost', transcript_path: transcript };
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'first' }));
    fs.appendFileSync(transcript, reply('a1', { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 50_000 }) + reply('a1', { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 50_000 }));
    await c.call('claude.event', ev('Stop', base));
    const cost = async () => (await states()).find((s) => s.id === 'sess-cost')?.cost;
    await waitUntil(async () => (await cost())?.answers === 1, 5_000);
    // (100 × 2 + 1000 × 10 + 50000 × 0.2) / 1e6, once although the answer has two lines
    expect((await cost())!.last.usd).toBeCloseTo(0.0202, 6);
    expect((await cost())!.last.messages).toBe(1);
    expect((await cost())!.totalUsd).toBeCloseTo(0.0202, 6);
    expect(JSON.stringify(await states())).not.toContain('SECRET'); // numbers only, never the words
    expect(JSON.stringify(await states())).not.toContain('.jsonl'); // and nothing about where the transcript is leaves the daemon
    // the next answer adds to the session
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'second' }));
    fs.appendFileSync(transcript, reply('a2', { input_tokens: 10, output_tokens: 500 }));
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await cost())?.answers === 2, 5_000);
    expect((await cost())!.last.usd).toBeCloseTo(0.00502, 6);
    expect((await cost())!.totalUsd).toBeCloseTo(0.02522, 6);
    // a response Claude gives without a new prompt (a background agent finished) is its own answer, not a repeat of the last
    fs.appendFileSync(transcript, reply('a3', { input_tokens: 10, output_tokens: 100 }));
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await cost())?.answers === 3, 5_000);
    expect((await cost())!.last.output).toBe(100);
  });

  it('a Stop that arrives after SessionEnd (async hooks, `claude -p`) still says what the answer cost; after a grace nothing of the session is kept', async () => {
    const transcript = path.join(env3.root, 'sess-late.jsonl');
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 10, output_tokens: output } } })}\n`;
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-late', transcript_path: transcript };
    const cost = async () => (await states()).find((s) => s.id === 'sess-late')?.cost;
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'once' }));
    fs.appendFileSync(transcript, reply('l1', 500));
    await c.call('claude.event', ev('SessionEnd', base));
    await c.call('claude.event', ev('Stop', base)); // overtaken by the SessionEnd
    await waitUntil(async () => (await cost())?.answers === 1, 5_000);
    expect((await cost())!.last.output).toBe(500);
    expect((await states()).find((s) => s.id === 'sess-late')?.state).toBe('ended');
    // once the grace has passed, where the answer began is forgotten: a Stop that turns up later has nothing to measure from
    await sleep(STOP_AFTER_END_GRACE_MS + 500);
    fs.appendFileSync(transcript, reply('l2', 700));
    await c.call('claude.event', ev('Stop', base));
    await sleep(2_500); // longer than the read (300 ms) and its one retry (1.5 s later)
    expect((await cost())!.answers).toBe(1);
  }, 30_000);

  it('says nothing about cost when it is switched off in Settings, and starts again when it is switched on', async () => {
    const transcript = path.join(env3.root, 'sess-nocost.jsonl');
    const reply = (id: string) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1000 } } })}\n`;
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-nocost', transcript_path: transcript };
    await c.call('config.patch', { claude: { showCost: false } });
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'quiet' }));
    fs.appendFileSync(transcript, reply('q1'));
    await c.call('claude.event', ev('Stop', base));
    await sleep(900);
    expect((await states()).find((s) => s.id === 'sess-nocost')?.cost).toBeUndefined();
    await c.call('config.patch', { claude: { showCost: true } });
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'loud' }));
    fs.appendFileSync(transcript, reply('q2'));
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-nocost')?.cost?.answers === 1, 5_000);
  });

  it('a stopped claude (Ctrl+Z: the shell reports exit 148) does not end the session', async () => {
    await c.call('claude.event', ev('UserPromptSubmit', { session_id: 'sess-susp', prompt: 'a long task' }));
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(500);
    const cmds = collect(c, 'pty.command');
    await c.call('pty.write', { data: 'claude() { return 148; }\r' });
    await sleep(300);
    await c.call('pty.write', { data: 'claude --resume\r' });
    await waitUntil(() => cmds.some((x) => /^claude --resume/.test(x.cmd) && x.exit === 148), 8_000);
    await sleep(200);
    expect((await states()).find((s) => s.id === 'sess-susp')?.state).toBe('working');
  });

  it('running claude in the shell and leaving it ends every session (it also covers a crashed Claude Code)', async () => {
    await c.call('claude.event', ev('UserPromptSubmit', { session_id: 'sess-3', prompt: 'still going' }));
    expect((await states()).some((s) => s.state === 'working')).toBe(true);
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(800);
    await c.call('pty.write', { data: 'claude() { :; }\r' });
    await sleep(300);
    await c.call('pty.write', { data: 'claude --resume\r' });
    await waitUntil(async () => (await states()).every((s) => s.state === 'ended'), 8_000);
  });

  // The real thing end to end: Claude Code fires its real hooks, the real `jaffer hook` reports from inside the daemon's shell
  // (JAFFER_SESSION is exported by Jaffer's shell integration), and the daemon ends up knowing what Claude did.
  it.skipIf(!CLAUDE)('a real Claude Code turn, run in the shell, reaches the live state through its real hooks', async () => {
    fs.writeFileSync(path.join(env3.userHome, 'notes.txt'), 'the deploy script is release.sh\n');
    const main = (b: any) => (b.tools?.length ?? 0) > 0; // the main request carries tools; background requests do not
    mock3.reset().queue(
      { kind: 'tool', id: 'toolu_real1', name: 'Read', input: { file_path: path.join(env3.userHome, 'notes.txt') }, text: 'Reading it.', when: main },
      { kind: 'text', text: 'The notes say the deploy script is release.sh.', when: main },
    );
    const known = new Set((await states()).map((s) => s.id)); // before Claude runs
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(800);
    await c.call('pty.write', { data: 'unset -f claude\r' }); // the stand-in function an earlier test left in this shell
    await sleep(400);
    await c.call('pty.write', { data: 'claude -p "read notes.txt and tell me what it says"\r' });
    // The state keeps no prompt or tool call, so the proof that the real hooks arrived is a session nobody had told the daemon
    // about: only Claude Code's own hooks, through the real `jaffer hook`, can have created it. `claude -p` exits right after its
    // last event, and the shell reporting that exit is what ends it.
    const real = async () => (await states()).find((s) => !known.has(s.id));
    await waitUntil(async () => (await real())?.state === 'ended', 60_000).catch(async (e) => {
      throw new Error(`${e.message}; sessions=${JSON.stringify(await states())}; mock saw ${mock3.requests.length} requests`);
    });
    const r = (await real())!;
    expect(r.id).toMatch(/\S/);
    expect(JSON.stringify(r)).not.toContain('notes.txt'); // and nothing of what was asked or read is kept
    expect(JSON.stringify(r)).not.toContain('.jsonl');
  }, 90_000);
});

/**
 * A stand-in for `claude` on the PATH of the daemon's shell, put there by the test user's own `~/.bash_profile` so that a shell started
 * after a restart (or a respawn) has it too: a shell function would not survive that. It says what it was given and exits with the
 * code in its `exit` file: 1 is a crash, 0 the person quitting.
 */
function standInClaude(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const code = path.join(dir, 'exit');
  fs.writeFileSync(code, '0');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/bash\necho "STAND-IN CLAUDE: $*"\nexit "$(cat '${code}')"\n`, { mode: 0o755 });
  return { dir, exitWith: (n: number) => fs.writeFileSync(code, String(n)) };
}

describe('a daemon does not claim hooks that belong to another Jaffer home (bundled daemon)', () => {
  it('leaves hooks that point at a different wrapper exactly as they were', async () => {
    const env4 = makeEnv();
    try {
      const file = path.join(env4.userHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // the user's real install, pointing at their real ~/.jaffer; this daemon runs with a different (temporary) Jaffer home
      const theirs = (arg: string) => [{ hooks: [{ type: 'command', command: `'/Users/someone/.jaffer/bin/jaffer' hook ${arg} # jaffer-managed`, timeout: 5 }] }];
      const before = JSON.stringify({ hooks: { SessionStart: theirs('session-start'), Stop: theirs('stop') } });
      fs.writeFileSync(file, before);
      const c4 = await ensureDaemon(env4.paths, {
        execPath: process.execPath,
        daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
        cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
        env: { HOME: env4.userHome, SHELL: '/bin/bash', PS1: '$ ' },
      });
      await c4.call('hello', {});
      await sleep(300);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      c4.close();
      const last = await tryConnect(env4.paths);
      await last?.call('app.shutdown', {}).catch(() => undefined);
      await sleep(300);
    } finally {
      env4.cleanup();
    }
  }, 30_000);
});

describe('the Mac stays awake while Claude or a long command works (bundled daemon; no caffeinate is ever run: the hold is written to a log)', () => {
  let env6: TestEnv;
  let c: RpcClient;
  let pid: number;
  const log = () => path.join(env6.root, 'hold.log');
  /** What the daemon asked for, in order: `hold` with the arguments for caffeinate, and `release`. */
  const lines = (): { op: string; args: string[] }[] => {
    try {
      return fs.readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const ops = () => lines().map((l) => l.op);
  /** A Claude Code hook event for a session of its own (the home is shared by the tests of this block). */
  const hook = (id: string, ev: string, over: object = {}) => c.call('claude.event', { session_id: id, hook_event_name: ev, cwd: env6.userHome, ...over });
  const state = async (id: string) => ((await c.call('claude.state', {})).sessions as ClaudeSession[]).find((s) => s.id === id)?.state;

  beforeAll(async () => {
    env6 = makeEnv();
    fs.writeFileSync(path.join(env6.userHome, '.zshenv'), 'skip_global_compinit=1\n');
    c = await ensureDaemon(env6.paths, {
      execPath: process.execPath,
      daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
      cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
      env: { HOME: env6.userHome, SHELL: '/bin/bash', PS1: '$ ', JAFFER_TEST_HOLD_LOG: log() },
    });
    pid = (await c.call('hello', {})).pid;
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(500);
  }, 30_000);

  afterAll(async () => {
    c?.close();
    const last = await tryConnect(env6.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    env6?.cleanup();
  });

  it('a working Claude holds once, for the daemon; the setting lets go at once and takes it up again', async () => {
    expect(ops()).toEqual([]);
    await hook('stay-1', 'SessionStart');
    await hook('stay-1', 'UserPromptSubmit', { prompt: 'go' });
    await waitUntil(() => ops().length > 0);
    expect(lines()).toEqual([{ op: 'hold', args: ['-i', '-w', String(pid)] }]); // (-w: it ends by itself if the daemon dies)
    // more events of the same turn: the same hold, not another
    await hook('stay-1', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_s1' });
    await hook('stay-1', 'PostToolUse', { tool_use_id: 'toolu_s1' });
    await hook('stay-1', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_s2' });
    await sleep(600);
    expect(ops()).toEqual(['hold']);
    // switched off: let go at once, and Claude still working holds nothing
    await c.call('config.patch', { session: { stayAwake: false } });
    await waitUntil(() => ops().length === 2);
    expect(ops()).toEqual(['hold', 'release']);
    await hook('stay-1', 'PostToolUse', { tool_use_id: 'toolu_s2' });
    await sleep(600);
    expect(ops()).toEqual(['hold', 'release']);
    // on again: Claude is still working, so it holds again
    await c.call('config.patch', { session: { stayAwake: true } });
    await waitUntil(() => ops().length === 3);
    expect(ops()).toEqual(['hold', 'release', 'hold']);
    // the work ends and the setting goes off in the delay of the release: it does not wait for it
    await hook('stay-1', 'SessionEnd');
    await waitUntil(async () => (await state('stay-1')) === 'ended');
    await c.call('config.patch', { session: { stayAwake: false } });
    await waitUntil(() => ops().length === 4);
    expect(ops()).toEqual(['hold', 'release', 'hold', 'release']);
    await c.call('config.patch', { session: { stayAwake: true } });
    await sleep(600);
    expect(ops().length).toBe(4); // nothing works: nothing is held
  }, 40_000);

  it('a background agent is work from a quiet Claude; a Claude that waits for the person is not', async () => {
    const before = ops().length;
    // an idle Claude with an agent running in the background
    await hook('stay-2', 'SessionStart');
    await hook('stay-2', 'SubagentStart', { agent_id: 'agent-1' });
    await waitUntil(() => ops().length === before + 1);
    expect(ops().slice(before)).toEqual(['hold']);
    expect(await state('stay-2')).toBe('idle');
    await hook('stay-2', 'SubagentStop', { agent_id: 'agent-1' });
    // (the agent ending starts the delay of the release; the next Claude takes it over)
    await hook('stay-3', 'UserPromptSubmit', { prompt: 'run it' });
    await hook('stay-3', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_w1' });
    await sleep(600);
    expect(ops().length).toBe(before + 1); // still the one hold
    // Claude asks for permission and waits: that is the person's turn, not work. The Mac may sleep after the usual delay.
    await hook('stay-3', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await waitUntil(async () => (await state('stay-3')) === 'needs-you');
    const asked = Date.now();
    await waitUntil(() => ops().length === before + 2, 25_000);
    expect(ops().slice(before)).toEqual(['hold', 'release']);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(13_000); // after the 15 s delay, not at once
    await sleep(500);
    expect(await state('stay-3')).toBe('needs-you');
    expect(ops().length).toBe(before + 2);
    // the person answers in the terminal: Claude works again, and holds again
    await c.call('pty.write', { data: 'y' });
    await waitUntil(async () => (await state('stay-3')) === 'working', 5_000);
    await waitUntil(() => ops().length === before + 3);
    expect(ops().slice(before)).toEqual(['hold', 'release', 'hold']);
    await c.call('pty.write', { data: '\x15' }); // (the shell's line is cleared)
    await hook('stay-3', 'SessionEnd');
    await hook('stay-2', 'SessionEnd');
  }, 60_000);

  it('a plain command that runs half a minute holds too, and lets go after it ends', async () => {
    // the work of the tests before has ended: wait out the delay of the last release
    await waitUntil(() => ops().length > 0 && ops()[ops().length - 1] === 'release', 25_000);
    const before = ops().length;
    const starts = collect(c, 'pty.start') as { cmd: string }[];
    const ends = collect(c, 'pty.command') as { cmd: string }[];
    const t0 = Date.now();
    await c.call('pty.write', { data: 'sleep 120\r' });
    await waitUntil(() => starts.some((s) => s.cmd === 'sleep 120'));
    await sleep(6_000);
    expect(ops().length).toBe(before); // not for a command that has just begun
    await waitUntil(() => ops().length === before + 1, 45_000);
    expect(ops()[before]).toBe('hold');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(29_000); // it had run half a minute
    await sleep(1_000);
    await c.call('pty.write', { data: '\x03' }); // the command ends
    await waitUntil(() => ends.some((e) => e.cmd === 'sleep 120'), 10_000);
    const ended = Date.now();
    await waitUntil(() => ops().length === before + 2, 25_000);
    expect(ops()[before + 1]).toBe('release');
    expect(Date.now() - ended).toBeGreaterThanOrEqual(13_000);
  }, 120_000);

  it('stopping the daemon lets go of the hold', async () => {
    await hook('stay-4', 'UserPromptSubmit', { prompt: 'go' });
    await waitUntil(async () => (await state('stay-4')) === 'working');
    await waitUntil(() => ops()[ops().length - 1] === 'hold');
    const held = ops().length;
    await c.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env6.paths, 300)), 10_000);
    expect(ops().length).toBe(held + 1);
    expect(ops()[held]).toBe('release');
  }, 30_000);
});

describe('how the daemon ends: the exit code and the socket (bundled daemon, started and watched here)', () => {
  /** Start the bundled daemon in a home of its own and wait until it answers. `exited` resolves with how it ended. */
  async function start(e: TestEnv) {
    fs.writeFileSync(path.join(e.userHome, '.zshenv'), 'skip_global_compinit=1\n');
    const child = spawn(process.execPath, [path.join(root, 'dist/daemon/jafferd.cjs')], {
      env: { ...process.env, HOME: e.userHome, JAFFER_HOME: e.home, SHELL: '/bin/bash', PS1: '$ ' },
      stdio: 'ignore',
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let c: RpcClient | null = null;
    await waitUntil(async () => {
      c = await tryConnect(e.paths, 300);
      return !!c;
    }, 15_000);
    return { child, exited, c: c! as RpcClient };
  }

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('%s ends it with code %i, and it lets go of the socket', async (signal, code) => {
    const e = makeEnv();
    try {
      const { child, exited, c } = await start(e);
      await c.call('session.attach', { cols: 100, rows: 30 });
      await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
      c.close();
      await sleep(600);
      child.kill(signal);
      const ended = await exited;
      expect(ended).toEqual({ code, signal: null });
      expect(fs.existsSync(e.paths.socket)).toBe(false); // and it let go of the socket
    } finally {
      e.cleanup();
    }
  }, 40_000);

  it('app.shutdown (a deliberate end: an update, Reset) ends it with code 0', async () => {
    const e = makeEnv();
    try {
      const { exited, c } = await start(e);
      await c.call('app.shutdown', {});
      expect(await exited).toEqual({ code: 0, signal: null });
      c.close();
    } finally {
      e.cleanup();
    }
  }, 40_000);

  it('the first reason to stop wins: more signals while it stops do not change the code, and a SIGTERM during app.shutdown keeps 0', async () => {
    const e = makeEnv();
    try {
      const { child, exited, c } = await start(e);
      await c.call('session.attach', { cols: 100, rows: 30 });
      await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
      c.close();
      await sleep(600);
      child.kill('SIGTERM');
      for (const ms of [5, 20, 40]) {
        await sleep(ms);
        if (child.exitCode === null) child.kill(ms === 20 ? 'SIGINT' : 'SIGTERM');
      }
      expect(await exited).toEqual({ code: 143, signal: null });
    } finally {
      e.cleanup();
    }
    const e2 = makeEnv();
    try {
      const { child, exited, c } = await start(e2);
      await c.call('app.shutdown', {});
      for (const ms of [10, 60, 120]) {
        await sleep(ms);
        if (child.exitCode === null) child.kill('SIGTERM');
      }
      expect(await exited).toEqual({ code: 0, signal: null }); // the person ended it: a signal that follows does not turn that into 143
      c.close();
    } finally {
      e2.cleanup();
    }
  }, 60_000);
});

describe('the login agent is gone (bundled daemon and CLI): no service.* methods, no `jaffer service`, nothing written under the user\'s Library/LaunchAgents', () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });

  it('service.status, service.install and service.remove are unknown methods, and the config has no keepRunning', async () => {
    const c = await connect();
    for (const m of ['service.status', 'service.install', 'service.remove']) await expect(c.call(m, {}), m).rejects.toThrow(/unknown method/);
    const session = (await c.call('config.get', {})).session;
    expect(session).toMatchObject({ stayAwake: true });
    expect(session).not.toHaveProperty('keepRunning');
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'LaunchAgents'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'bin', 'jafferd'))).toBe(false); // no wrapper for launchd either
  });

  it('`jaffer service` is not a command any more, and the help does not mention it or a login agent', () => {
    const r = cli('service', 'status');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command: service/);
    expect(cli('--help').stdout).not.toMatch(/jaffer service|keepRunning|login agent|launchd/i);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'LaunchAgents'))).toBe(false);
  }, 30_000);
});
