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
const clients: RpcClient[] = [];

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=daemon'], { stdio: 'ignore' });
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=cli'], { stdio: 'ignore' });
  env = makeEnv();
  fs.writeFileSync(path.join(env.userHome, '.zshenv'), 'skip_global_compinit=1\n');
  mock = new MockAnthropic();
  const url = await mock.listen();
  launcher = {
    execPath: process.execPath,
    daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
    cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
    env: {
      HOME: env.userHome,
      SHELL: '/bin/bash',
      JAFFER_TICK_MS: '400',
      ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
      ANTHROPIC_BASE_URL: url,
      PS1: '$ ',
      // the panel's Claude Code process (only used by the Claude Code engine test): isolated profile, talks to the mock
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
    expect(cmds[0]).toMatchObject({ cmd: 'echo persisted-marker-42', exit: 0, by: 'user' });
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

  it('records what happens in the session as memory episodes and learns from them', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    for (let i = 0; i < 3; i++) {
      await c.call('pty.write', { data: `echo build-step-${i}\r` });
      await waitUntil(() => cmds.length > i);
    }
    await waitUntil(async () => (await c.call('memory.stats', {})).episodesPending >= 3);
    const res = await c.call('memory.reflect', { force: true });
    expect(res.episodes).toBeGreaterThanOrEqual(3);
    // environment fact is learned immediately, offline
    const list = await c.call('memory.list', {});
    expect(list.items.some((i: any) => i.kind === 'environment')).toBe(true);
  });

  it('exposes the same memory through the CLI, with and without the daemon', async () => {
    const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });
    const rem = cli('remember', 'Always run the linter before committing', '--kind', 'convention');
    expect(rem.status, rem.stderr).toBe(0);
    expect(rem.stdout).toContain('remembered');
    const rec = cli('recall', 'linter committing');
    expect(rec.stdout).toContain('linter before committing');
    const st = cli('status');
    expect(st.stdout).toContain('running');
    expect(st.stdout).toMatch(/claude: .*(signed in|signed out|not installed)/); // Jaffer runs on the Claude login; there is no key to report
    expect(st.stdout).not.toMatch(/api key/i);
    // the Claude Code SessionStart hook prints the context Claude will start with
    const hook = spawnSync(process.execPath, [launcher.cliScript!, 'hook', 'session-start'], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', input: JSON.stringify({ cwd: env.userHome, source: 'startup' }) });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain('# Memory from Jaffer');
    expect(hook.stdout).toContain('linter before committing');
  });

  it('puts a working `jaffer` command on the PATH of the session shell', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await c.call('pty.write', { data: 'jaffer recall linter\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'jaffer recall linter'));
    const ev = cmds.find((x) => x.cmd === 'jaffer recall linter');
    expect(ev.exit).toBe(0);
    expect(ev.output).toContain('linter before committing');
    expect(fs.existsSync(path.join(env.paths.binDir, 'jaffer'))).toBe(true);
  });

  it('survives a daemon restart: same directory, previous screen restored, memory intact', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    fs.mkdirSync(path.join(env.userHome, 'restart-dir'));
    await c.call('pty.write', { data: `cd ${path.join(env.userHome, 'restart-dir')}\r` });
    await waitUntil(async () => (await c.call('session.info', {})).cwd.endsWith('restart-dir'));
    await sleep(300);
    await c.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env.paths, 300)), 8000);
    clients.length = 0;
    const c2 = await connect();
    const info = await c2.call('session.info', {});
    expect(info.cwd.endsWith('restart-dir')).toBe(true);
    const att = await c2.call('session.attach', { cols: 100, rows: 30 });
    expect(att.snapshot.data).toContain('persisted-marker-42');
    expect(att.snapshot.data).toContain('session restored');
    // memory persisted too
    expect((await c2.call('memory.list', {})).items.length).toBeGreaterThan(0);
    void cmds;
  }, 30_000);

  // Model curation runs through the user's Claude login (`claude -p`), here the real claude against the mock API.
  it.skipIf(!CLAUDE)('memory evolves on its own: rules, model curation and Claude Code transcripts, with no manual trigger', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    // consent given, aggressive cadence so the test does not wait minutes
    await c.call('config.patch', { onboarded: true, memory: { llm: 'auto', reflectEveryN: 4, idleSeconds: 1, llmMinIntervalSec: 0 }, ingest: { claudeCode: true } });
    // the model-curated memory the mock reflector will propose
    mock.reset().queue({ kind: 'text', text: JSON.stringify({ ops: [{ op: 'add', kind: 'lesson', scope: 'global', text: 'Run the linter before every commit in this workspace', confidence: 0.8, why: 'repeated' }] }) });
    const before = (await c.call('memory.list', {})).items.length;

    // (1) a Claude Code session that happened elsewhere: the user told it a durable rule
    const proj = path.join(env.userHome, '.claude', 'projects', '-work-app');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'sess.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'From now on always use tabs, never spaces, for indentation.' }, cwd: env.userHome, timestamp: new Date().toISOString(), sessionId: 's1' }) + '\n');

    // (2) ordinary shell activity
    for (let i = 0; i < 5; i++) {
      await c.call('pty.write', { data: `pnpm test --run-${i}\r` });
      await waitUntil(() => cmds.length > 0 && cmds.filter((x) => x.cmd.startsWith('pnpm test')).length > i, 8000);
    }

    // nobody calls memory.reflect: the daemon must do it by itself
    try {
      await waitUntil(async () => {
        const items = (await c.call('memory.list', {})).items as { text: string; source: string }[];
        return items.some((i) => /tabs/i.test(i.text)) && items.some((i) => /linter before every commit/.test(i.text));
      }, 20_000);
    } catch (e) {
      // say what the daemon had done by then, so a slow or broken platform can be told apart
      const items = ((await c.call('memory.list', {})).items as { text: string; source: string }[]).map((i) => `${i.source}: ${i.text}`);
      const stats = await c.call('memory.stats', {});
      const log = await c.call('memory.log', { limit: 20 });
      throw new Error(`memory did not evolve in time. items=${JSON.stringify(items)} stats=${JSON.stringify(stats)} runs=${JSON.stringify(log.runs.map((r: any) => [r.sources, r.reason]))} reflectorRequests=${mock.requests.length} commands=${JSON.stringify(cmds.map((x: any) => [x.cmd, x.exit]))} (${(e as Error).message})`);
    }
    const items = (await c.call('memory.list', {})).items as { text: string; source: string; kind: string }[];
    expect(items.length).toBeGreaterThan(before);
    expect(items.find((i) => /tabs/i.test(i.text))!.source).toBe('user'); // learned from the Claude Code transcript
    expect(items.find((i) => /linter before every commit/.test(i.text))!.source).toBe('reflector'); // curated by the model
    // A stated rule is reflected on at once (before the shell commands pile up), so one request may carry only the transcript
    // line and the commands go out in another. Both must have reached the model. A pass applies its offline rules before it
    // sends its request, so the memory can be visible a moment before the request arrives: wait for both.
    const sentTo = () => mock.requests.map((r) => JSON.stringify(r.body?.messages ?? ''));
    await waitUntil(() => sentTo().some((s) => s.includes('pnpm test')) && sentTo().some((s) => s.includes('From now on always use tabs')), 20_000);
    // and every change is journaled so it can be undone
    const log = await c.call('memory.log', { limit: 100 });
    expect(log.runs.some((r: any) => r.sources.includes('reflector'))).toBe(true);
    const run = log.runs.find((r: any) => r.sources.includes('reflector') && r.ops.some((o: any) => /linter/.test(o.text ?? '')));
    const rev = await c.call('memory.revert', { runId: run.runId });
    expect(rev.reverted).toBeGreaterThan(0);
    expect(((await c.call('memory.list', {})).items as any[]).some((i) => /linter before every commit/.test(i.text))).toBe(false);
  }, 50_000);

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
      env: { HOME: env2.userHome, SHELL: '/bin/bash', JAFFER_TICK_MS: '400', PS1: '$ ', PATH: `${fake.dir}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' },
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
        JAFFER_TICK_MS: '400',
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
      expect((s.hooks[e] as any[]).some((x) => x.hooks.some((h: any) => String(h.command).includes('# jaffer-managed'))), e).toBe(true);
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
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(800);
    await c.call('pty.write', { data: 'unset -f claude\r' }); // the stand-in function an earlier test left in this shell
    await sleep(400);
    await c.call('pty.write', { data: 'claude -p "read notes.txt and tell me what it says"\r' });
    const real = async () => (await states()).find((s) => /notes\.txt/.test(s.prompt ?? ''));
    // the turn ends with Claude exiting: the shell reports it and the session ends, keeping what it saw
    await waitUntil(async () => {
      const r = await real();
      // async hooks can land in any order, so wait for all of what it should have seen
      return r?.state === 'ended' && !!r.lastReply && r.activity.some((a) => a.status === 'done');
    }, 60_000).catch(async (e) => {
      throw new Error(`${e.message}; sessions=${JSON.stringify(await states())}; mock saw ${mock3.requests.length} requests`);
    });
    const r = (await real())!;
    expect(r.prompt).toContain('read notes.txt'); // what the user asked, from the real UserPromptSubmit
    expect(r.activity.some((a) => a.name === 'Read' && a.status === 'done' && /notes\.txt/.test(a.summary))).toBe(true);
    expect(r.lastReply).toContain('deploy script is release.sh');
  }, 90_000);
});
