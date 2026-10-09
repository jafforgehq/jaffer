import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { fakeClaude } from './helpers/fake-claude';
import { MockAnthropic } from './helpers/mock-anthropic';
import { ensureDaemon, tryConnect, type Launcher } from '../src/core/daemon-client';
import type { RpcClient } from '../src/core/rpc';
import { sleep } from '../src/shared/util';
import { findClaude } from '../src/core/integrations/claude';
import type { ClaudeSession } from '../src/core/claude/watcher';
import { AUTO_RESUME_TEST, RESTART_HOLD_TEST_MS } from '../src/shared/keep-running';

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

  it('`jaffer config set` says so when a value is not of the right kind, instead of storing it and printing ok', async () => {
    const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });
    const bad = cli('config', 'set', 'safety.protectedBranches', 'main,prod'); // the string "main,prod", not a list
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/safety\.protectedBranches/);
    expect(bad.stdout).not.toContain('ok');
    const off = cli('config', 'set', 'session.restoreScreen', 'off'); // not a boolean: it must not look as if the screen were no longer kept
    expect(off.status).not.toBe(0);
    expect(JSON.parse(cli('config', 'get', 'session.restoreScreen').stdout)).toBe(true);
    expect(JSON.parse(cli('config', 'get', 'safety.protectedBranches').stdout)).toContain('main');
    const good = cli('config', 'set', 'safety.protectedBranches', '["wip","release/*"]');
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(cli('config', 'get', 'safety.protectedBranches').stdout)).toEqual(['wip', 'release/*']);
    expect(cli('config', 'set', 'session.restoreScreen', 'true').status).toBe(0);
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

  describe('Claude Code that was running when Jaffer stopped', () => {
    const ID = '0b6f1c52-3a3e-4d0e-9f4a-6f0f8c2f6a11';
    const OTHER = '0c7e2d63-4b4f-4e1f-8a5b-7a1a9d3a7b22';

    // These are about the offer (the Resume button). Resuming by itself has its own suite below, with a stand-in `claude` on the
    // shell's PATH: here a typed `claude --resume` would start whatever `claude` this machine has, inside the shell these tests use.
    beforeAll(async () => {
      const c = await connect();
      await c.call('config.patch', { session: { autoResume: false } });
    });

    async function inFolder(name: string) {
      const c = await connect();
      await c.call('session.attach', { cols: 100, rows: 30 });
      const dir = path.join(env.userHome, name);
      fs.mkdirSync(dir, { recursive: true });
      await c.call('pty.write', { data: `cd ${dir}\r` });
      await waitUntil(async () => (await c.call('session.info', {})).cwd.endsWith(name));
      await sleep(300);
      const real = fs.realpathSync(dir);
      const transcript = path.join(env.userHome, `${name}.jsonl`);
      fs.writeFileSync(transcript, '{}\n');
      const hook = (cl: typeof c, name2: string, id = ID, over: object = {}) => cl.call('claude.event', { session_id: id, hook_event_name: name2, cwd: real, transcript_path: transcript, ...over });
      return { c, real, hook };
    }
    const restart = async (c: Awaited<ReturnType<typeof connect>>) => {
      await sleep(300);
      await c.call('app.shutdown', {});
      await waitUntil(async () => !(await tryConnect(env.paths, 300)), 8000);
      clients.length = 0;
      return connect();
    };

    it('is offered back after a restart, in the folder it ran in, and stops being offered when Claude Code starts again', async () => {
      const { c, real, hook } = await inFolder('resume-a');
      await hook(c, 'SessionStart');
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      expect(await c.call('claude.resume', {})).toBeNull(); // it is running: nothing to offer yet
      const c2 = await restart(c); // no SessionEnd ever came: a reboot, an update or a crash
      await waitUntil(async () => (await c2.call('claude.resume', {}))?.id === ID, 8000);
      expect(await c2.call('claude.resume', {})).toMatchObject({ id: ID, cwd: real });
      const pushed = collect(c2, 'claude.resume');
      await hook(c2, 'SessionStart'); // the person resumed it (or started Claude Code themselves)
      await waitUntil(() => pushed.length > 0);
      expect(pushed.at(-1)).toBeNull();
      expect(await c2.call('claude.resume', {})).toBeNull();
    }, 40_000);

    it('is not offered after the conversation was ended on purpose (SessionEnd), even across a restart', async () => {
      const { c, hook } = await inFolder('resume-b');
      await hook(c, 'SessionStart');
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      await hook(c, 'SessionEnd');
      const c2 = await restart(c);
      await sleep(800);
      expect(await c2.call('claude.resume', {})).toBeNull();
      expect(fs.existsSync(path.join(env.paths.sessionDir, 'claude.json'))).toBe(false);
    }, 40_000);

    it('a SessionEnd whose reason is "other" (Claude Code stopped by a logout or a shutdown before Jaffer was) keeps the conversation; the ends the person chose forget it', async () => {
      const { c, hook } = await inFolder('resume-reason');
      const file = path.join(env.paths.sessionDir, 'claude.json');
      await hook(c, 'SessionStart');
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      await hook(c, 'SessionEnd', ID, { reason: 'other' });
      await sleep(300);
      expect(fs.existsSync(file)).toBe(true);
      expect((await c.call('claude.resume', {}))?.id).toBe(ID); // the button now, and the same after the reboot
      for (const reason of ['prompt_input_exit', 'clear', 'logout']) {
        await hook(c, 'SessionStart'); // the same conversation once more
        await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
        await hook(c, 'SessionEnd', ID, { reason });
        await waitUntil(async () => (await c.call('claude.resume', {})) === null, 5000);
        expect(fs.existsSync(file), reason).toBe(false);
      }
    }, 40_000);

    it('is offered at once when claude crashes (a non-zero exit), is pushed to the window, and can be dismissed; a normal exit offers nothing', async () => {
      const { c, hook } = await inFolder('resume-c');
      await c.call('pty.write', { data: 'claude() { return 1; }\r' });
      await sleep(400);
      const pushed = collect(c, 'claude.resume');
      await hook(c, 'SessionStart');
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      await c.call('pty.write', { data: 'claude\r' });
      await waitUntil(() => pushed.some((o) => o?.id === ID), 8000); // it died: resume it?
      await c.call('claude.resume.dismiss', {});
      await waitUntil(() => pushed.at(-1) === null, 8000);
      expect(await c.call('claude.resume', {})).toBeNull();
      // and when it exits normally there is nothing to offer
      await c.call('pty.write', { data: 'claude() { return 0; }\r' });
      await sleep(400);
      await hook(c, 'SessionStart', OTHER);
      await c.call('pty.write', { data: 'claude\r' });
      await sleep(1200);
      expect(await c.call('claude.resume', {})).toBeNull();
      await c.call('pty.write', { data: 'unset -f claude\r' });
      await sleep(300);
    }, 40_000);

    it('turning the offer off forgets the conversation (as Settings says), so it is not back when it is turned on again', async () => {
      const { c, hook } = await inFolder('resume-e');
      const file = path.join(env.paths.sessionDir, 'claude.json');
      await hook(c, 'SessionStart');
      await waitUntil(() => fs.existsSync(file), 8000);
      await c.call('config.patch', { session: { resumeClaude: false } });
      await waitUntil(() => !fs.existsSync(file), 8000); // nothing of it is kept while it is off
      await c.call('config.patch', { session: { resumeClaude: true } });
      const c2 = await restart(c);
      await sleep(800);
      expect(await c2.call('claude.resume', {})).toBeNull();
    }, 40_000);

    it('a hook that arrives after the person quit does not bring the conversation back, and Claude Code starting it again does', async () => {
      const { c, hook } = await inFolder('resume-f');
      const file = path.join(env.paths.sessionDir, 'claude.json');
      await c.call('pty.write', { data: 'claude() { return 0; }\r' });
      await sleep(400);
      await hook(c, 'SessionStart');
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      await waitUntil(() => fs.existsSync(file), 8000);
      await c.call('pty.write', { data: 'claude\r' });
      await waitUntil(() => !fs.existsSync(file), 8000); // quit on purpose: forgotten
      await hook(c, 'PostToolUse', ID, { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'late-1' }); // already on its way when it quit
      await sleep(400);
      expect(fs.existsSync(file)).toBe(false);
      expect(await c.call('claude.resume', {})).toBeNull();
      await hook(c, 'SessionStart'); // `claude --resume` by hand
      await waitUntil(() => fs.existsSync(file), 8000);
      await c.call('pty.write', { data: 'unset -f claude\r' });
      await sleep(300);
    }, 40_000);

    it('an offer that is waiting survives `claude --version` (a command that only asks is not the conversation ending)', async () => {
      const { c, hook } = await inFolder('resume-g');
      await hook(c, 'SessionStart', OTHER); // its own id: the home is shared by these tests, and a conversation keeps the folder it began in
      await hook(c, 'UserPromptSubmit', OTHER, { prompt: 'go' });
      const c2 = await restart(c); // a reboot
      await waitUntil(async () => (await c2.call('claude.resume', {}))?.id === OTHER, 8000);
      await c2.call('session.attach', { cols: 100, rows: 30 });
      await c2.call('pty.write', { data: 'claude() { return 0; }\r' });
      await sleep(400);
      await c2.call('pty.write', { data: 'claude --version\r' });
      await sleep(1200);
      expect((await c2.call('claude.resume', {}))?.id).toBe(OTHER);
      await c2.call('pty.write', { data: 'unset -f claude\r' });
      await sleep(300);
    }, 40_000);

    it('a shell that is restarted takes Claude with it, and the conversation can be resumed afterwards', async () => {
      const RESTARTED = '0d8f3e74-5c5f-4f20-9b6c-8b2b0e4b8c33'; // its own id: the home is shared by these tests, and a conversation keeps the folder it began in
      const { c, real, hook } = await inFolder('resume-h');
      await hook(c, 'SessionStart', RESTARTED);
      await hook(c, 'UserPromptSubmit', RESTARTED, { prompt: 'go' });
      expect(await c.call('claude.resume', {})).toBeNull(); // it is running: nothing to offer yet
      const before = (await c.call('pane.list', {}))[0];
      await c.call('session.restart', {});
      await waitUntil(async () => {
        const p = (await c.call('pane.list', {}))[0];
        return p.alive && p.pid !== before.pid;
      }, 10_000);
      // the old shell took its Claude with it: no conversation counts as running any more
      await waitUntil(async () => (await c.call('claude.state', {})).sessions.every((s: any) => s.state === 'ended'), 8000);
      // and the resume point was not forgotten with it
      await waitUntil(async () => (await c.call('claude.resume', {}))?.id === RESTARTED, 8000);
      expect(await c.call('claude.resume', {})).toMatchObject({ id: RESTARTED, cwd: real });
      expect(fs.existsSync(path.join(env.paths.sessionDir, 'claude.json'))).toBe(true);
    }, 40_000);

    it('a SessionEnd that the dying Claude sends just after its shell exited does not forget the conversation', async () => {
      const DYING = '0e9a4f85-6d60-4a31-8c7d-9c3c1f5c9d44'; // its own id, as above
      const { c, real, hook } = await inFolder('resume-i');
      const file = path.join(env.paths.sessionDir, 'claude.json');
      await hook(c, 'SessionStart', DYING);
      await hook(c, 'UserPromptSubmit', DYING, { prompt: 'go' });
      await waitUntil(() => fs.existsSync(file), 8000);
      const before = (await c.call('pane.list', {}))[0];
      await c.call('session.restart', {});
      await waitUntil(async () => {
        const p = (await c.call('pane.list', {}))[0];
        return p.alive && p.pid !== before.pid;
      }, 10_000);
      // the hook is asynchronous: Claude, killed with its shell, says goodbye after the shell's exit was seen
      await hook(c, 'SessionEnd', DYING);
      await sleep(400);
      expect(fs.existsSync(file)).toBe(true);
      expect(await c.call('claude.resume', {})).toMatchObject({ id: DYING, cwd: real });
      expect((await c.call('claude.state', {})).sessions.every((s: any) => s.state === 'ended')).toBe(true); // the watcher still ends it
    }, 40_000);

    it('is not offered when the person turned it off, and never from a made-up id', async () => {
      const { c, hook } = await inFolder('resume-d');
      await c.call('config.patch', { session: { resumeClaude: false } });
      await hook(c, 'SessionStart');
      const c2 = await restart(c);
      await sleep(800);
      expect(await c2.call('claude.resume', {})).toBeNull();
      await c2.call('config.patch', { session: { resumeClaude: true } });
      await hook(c2, 'SessionStart', 'abc; rm -rf /');
      expect(fs.existsSync(path.join(env.paths.sessionDir, 'claude.json'))).toBe(false); // nothing that could be typed into a shell was kept
      expect(await c2.call('claude.resume', {})).toBeNull();
    }, 40_000);
  });

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

  it('connecting Claude Code after a plain-terminal first run clears "skipped": the person has adopted it', async () => {
    await c.call('config.patch', { claude: { skipped: true } });
    expect((await c.call('config.get', {})).claude.skipped).toBe(true);
    await c.call('setup.claude.install', { mcp: false });
    expect((await c.call('config.get', {})).claude.skipped).toBe(false);
  });

  it('connecting for the live panel installs the hooks only: no MCP server is registered unless it is asked for', async () => {
    const before = fake.calls().length;
    const res = await c.call('setup.claude.install', { mcp: false });
    expect(res.status.hooks).toBe(true);
    expect(res.messages.join('\n')).not.toMatch(/MCP/);
    expect(fake.calls().slice(before).some((l) => l.startsWith('mcp add'))).toBe(false);
    const full = await c.call('setup.claude.install', {}); // Settings → Claude Code → Connect still adds the memory tools
    expect(full.messages.join('\n')).toMatch(/MCP/);
    expect(fake.calls().some((l) => l.startsWith('mcp add'))).toBe(true);
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
    // the last test runs the real `claude -p` here: whatever it leaves behind, this shell must not start an interactive Claude Code
    await c.call('config.patch', { session: { autoResume: false } });
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
  // how many seconds it waits for a line typed into it before it exits, like Claude's own prompt (none: an empty file)
  const hold = path.join(dir, 'hold');
  fs.writeFileSync(hold, '');
  // how many seconds it sleeps without reading anything, like `claude update` or `claude --version` while they run (none: an empty file)
  const nap = path.join(dir, 'nap');
  fs.writeFileSync(nap, '');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/bash\necho "RESUMED: $*"\nn="$(cat '${nap}')"\nif [ -n "$n" ]; then sleep "$n"; fi\nh="$(cat '${hold}')"\nif [ -n "$h" ]; then read -t "$h" -r _ || true; fi\nexit "$(cat '${code}')"\n`, { mode: 0o755 });
  // how many seconds the person's startup file keeps a new shell from its first prompt (none: an empty file)
  const slow = path.join(dir, 'slow-start');
  fs.writeFileSync(slow, '');
  return {
    dir,
    slow,
    exitWith: (n: number) => fs.writeFileSync(code, String(n)),
    startsAfter: (seconds: number) => fs.writeFileSync(slow, seconds ? String(seconds) : ''),
    waitsForALine: (seconds: number) => fs.writeFileSync(hold, seconds ? String(seconds) : ''),
    sleeps: (seconds: number) => fs.writeFileSync(nap, seconds ? String(seconds) : ''),
  };
}

/**
 * A stand-in for `ssh` into a server whose shell has an integration of its own (fish 4 by default; iTerm2's, kitty's, WezTerm's on a
 * server): it prints what that shell prints, the marks of a prompt, a command with no command line, its end and the next prompt, so
 * that by the marks alone the shell is at a prompt with nothing running. Then, for the seconds in its `stay` file, it keeps every line
 * typed into it in its `got` file: what the remote shell would have run. Put next to the stand-in `claude`, on the shell's PATH.
 */
function standInSsh(dir: string) {
  const got = path.join(dir, 'ssh-got');
  const stay = path.join(dir, 'ssh-stay');
  fs.writeFileSync(got, '');
  fs.writeFileSync(stay, '3');
  const script = [
    '#!/bin/bash',
    "printf '\\033]133;D;0\\007\\033]133;A\\007'",
    "printf '\\033]133;C\\007'",
    "printf '\\033]133;D;0\\007\\033]133;A\\007'",
    `end=$((SECONDS + $(cat '${stay}')))`,
    `while [ "$SECONDS" -lt "$end" ]; do if IFS= read -r -t 1 line; then printf '%s\\n' "$line" >> '${got}'; fi; done`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'ssh'), script, { mode: 0o755 });
  return {
    got: () => fs.readFileSync(got, 'utf8'),
    staysFor: (seconds: number) => fs.writeFileSync(stay, String(seconds)),
    clear: () => fs.writeFileSync(got, ''),
  };
}

describe('Claude Code comes back by itself (bundled daemon, a stand-in claude, the timing on a millisecond scale)', () => {
  const T = AUTO_RESUME_TEST;
  let env5: TestEnv;
  let fake: ReturnType<typeof standInClaude>;
  const launcher5 = (): Launcher => ({
    execPath: process.execPath,
    daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
    cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
    env: { HOME: env5.userHome, SHELL: '/bin/bash', JAFFER_TICK_MS: '400', PS1: '$ ', JAFFER_TEST_AUTORESUME_FAST: '1' },
  });
  const connect5 = () => ensureDaemon(env5.paths, launcher5());
  const restart5 = async (c: RpcClient) => {
    await sleep(300);
    await c.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env5.paths, 300)), 8000);
    return connect5();
  };
  /** What `claude.autoresume` pushed, with when this client saw it. */
  const track = (c: RpcClient) => {
    const got: { state: string; id: string; typesAt?: number; seenAt: number }[] = [];
    c.on('claude.autoresume', (d) => got.push({ ...d, seenAt: Date.now() }));
    return got;
  };
  const states = (evs: { state: string }[]) => evs.map((e) => e.state);
  /** The terminal's output from now on, and when a text first appeared in it. */
  const terminal = (c: RpcClient) => {
    let text = '';
    const firstSeen = new Map<string, number>();
    const watching = new Set<string>();
    c.on('pty.data', (d) => {
      text += d.data;
      for (const s of watching) if (!firstSeen.has(s) && text.includes(s)) firstSeen.set(s, Date.now());
    });
    return {
      text: () => text,
      count: (s: string) => text.split(s).length - 1,
      watch: (s: string) => void watching.add(s),
      seenAt: (s: string) => firstSeen.get(s),
    };
  };
  const commands = (c: RpcClient) => collect(c, 'pty.command') as { cmd: string; exit: number | null; output: string }[];

  async function inFolder5(name: string) {
    const c = await connect5();
    await c.call('session.attach', { cols: 100, rows: 30 });
    const dir = path.join(env5.userHome, name);
    fs.mkdirSync(dir, { recursive: true });
    await c.call('pty.write', { data: `cd ${dir}\r` });
    await waitUntil(async () => (await c.call('session.info', {})).cwd.endsWith(name));
    await sleep(300);
    const real = fs.realpathSync(dir);
    const transcript = path.join(env5.userHome, `${name}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
    const hook = (cl: RpcClient, ev: string, id: string, over: object = {}) => cl.call('claude.event', { session_id: id, hook_event_name: ev, cwd: real, transcript_path: transcript, ...over });
    return { c, real, hook };
  }

  beforeAll(async () => {
    env5 = makeEnv();
    fake = standInClaude(path.join(env5.root, 'stand-in'));
    // the person's own startup file, read after the system's (which may reorder PATH): the stand-in comes first
    fs.writeFileSync(path.join(env5.userHome, '.bash_profile'), `PATH='${fake.dir}':"$PATH"\nif [ -s '${fake.slow}' ]; then sleep "$(cat '${fake.slow}')"; fi\n`);
    const c = await connect5();
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await sleep(500);
    const cmds = commands(c);
    await c.call('pty.write', { data: 'command -v claude\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'command -v claude'), 8000);
    expect(cmds.find((x) => x.cmd === 'command -v claude')!.output).toContain(path.join(fake.dir, 'claude')); // not a real Claude Code
    c.close();
  }, 30_000);

  afterAll(async () => {
    const last = await tryConnect(env5.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    env5?.cleanup();
  });

  it('after a restart it types `claude --resume <id>` by itself, once, and a window that connects meanwhile is told of the notice', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-00000000000a';
    const { c, hook } = await inFolder5('auto-a');
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    fake.exitWith(0); // the resumed Claude is later quit on purpose
    // Nothing waits for this client: the new shell's first prompt may announce before it connects (a window opening after a
    // reboot, the app reconnecting after an update). What it was not pushed, it is told when it asks.
    const c2 = await restart5(c);
    const events = track(c2);
    const asked = (await c2.call('claude.autoresume.state', {})) as { state: string; id: string; typesAt: number } | null;
    const screen = async () => ((await c2.call('session.snapshot', {})) as { data: string }).data;
    await waitUntil(async () => (await screen()).includes(`RESUMED: --resume ${ID}`), 15_000);
    const told = events.find((e) => e.state === 'pending') ?? asked;
    expect(told).toMatchObject({ state: 'pending', id: ID });
    expect(states(events).at(-1)).toBe('typed');
    expect(await c2.call('claude.autoresume.state', {})).toBeNull(); // typed: no notice running any more
    // exactly that line, and only once
    expect(await screen()).toContain(`claude --resume ${ID}`);
    await sleep(T.quietMs + T.waitsMs[1]! + 800);
    expect((await screen()).split(`RESUMED: --resume ${ID}`).length - 1).toBe(1);
    expect(states(events).filter((x) => x === 'typed')).toHaveLength(1);
    expect(await c2.call('claude.resume', {})).toBeNull(); // it was quit on purpose afterwards: nothing more to resume
    c2.close();
  }, 40_000);

  it('with "Resume Claude automatically" off it types nothing and the button is still offered; switching it on resumes it', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-00000000000b';
    const { c, hook } = await inFolder5('auto-b');
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    await c.call('config.patch', { session: { autoResume: false } });
    fake.exitWith(0);
    const c2 = await restart5(c);
    const events = track(c2);
    const term = terminal(c2);
    await c2.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c2.call('claude.resume', {}))?.id === ID, 8000);
    await sleep(T.quietMs + T.noticeMs + 1200);
    expect(events).toEqual([]);
    expect(((await c2.call('session.snapshot', {})) as { data: string }).data).not.toContain(`RESUMED: --resume ${ID}`);
    expect((await c2.call('claude.resume', {}))?.id).toBe(ID); // the button is still there
    // switched on, it goes ahead without waiting for anything else
    await c2.call('config.patch', { session: { autoResume: true } });
    await waitUntil(() => term.count(`RESUMED: --resume ${ID}`) > 0, 10_000);
    expect(states(events)).toEqual(['pending', 'typed']);
    c2.close();
  }, 40_000);

  it('Cancel during the notice types nothing, leaves the button, and holds for that conversation', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-00000000000c';
    const { c, hook } = await inFolder5('auto-c');
    const events = track(c);
    const term = terminal(c);
    const cmds = commands(c);
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    fake.exitWith(1);
    await c.call('pty.write', { data: 'claude\r' }); // Claude Code crashes
    await waitUntil(() => events.some((e) => e.state === 'pending' && e.id === ID), 10_000);
    // a window that opens now, after the announcement, is told what is running, and its Cancel works
    const late = await connect5();
    const pending = events.find((e) => e.state === 'pending')!;
    expect(await late.call('claude.autoresume.state', {})).toEqual({ state: 'pending', id: ID, typesAt: pending.typesAt });
    expect(await late.call('claude.autoresume.cancel', {})).toBe(true);
    await waitUntil(() => events.some((e) => e.state === 'cancelled'), 5000);
    expect(await late.call('claude.autoresume.state', {})).toBeNull();
    late.close();
    await sleep(T.noticeMs + 800);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
    expect((await c.call('claude.resume', {}))?.id).toBe(ID); // the button is left
    // the next prompt does not bring it back
    await c.call('pty.write', { data: 'echo after-cancel\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'echo after-cancel'), 8000);
    await sleep(T.quietMs + T.noticeMs + 800);
    expect(states(events)).toEqual(['pending', 'cancelled']);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
    await c.call('claude.resume.dismiss', {});
    c.close();
  }, 40_000);

  it('a deliberate end is never resumed: `claude` quitting with 0, or a SessionEnd (also across a restart)', async () => {
    const QUIT = '1a2b3c4d-0000-4a00-8a00-00000000000d';
    const ENDED = '1a2b3c4d-0000-4a00-8a00-00000000000e';
    const { c, hook } = await inFolder5('auto-d');
    const events = track(c);
    const term = terminal(c);
    const cmds = commands(c);
    await hook(c, 'SessionStart', QUIT);
    await hook(c, 'UserPromptSubmit', QUIT, { prompt: 'go' });
    fake.exitWith(0);
    await c.call('pty.write', { data: 'claude\r' }); // the person quits Claude Code
    await waitUntil(() => cmds.some((x) => x.cmd === 'claude' && x.exit === 0), 8000);
    await sleep(T.quietMs + T.noticeMs + 800);
    expect(events).toEqual([]);
    expect(term.count(`RESUMED: --resume ${QUIT}`)).toBe(0);
    expect(await c.call('claude.resume', {})).toBeNull();
    // a conversation ended with SessionEnd, then a restart
    await hook(c, 'SessionStart', ENDED);
    await hook(c, 'UserPromptSubmit', ENDED, { prompt: 'go' });
    await hook(c, 'SessionEnd', ENDED);
    const c2 = await restart5(c);
    const events2 = track(c2);
    await c2.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c2.call('pane.list', {}))[0].alive);
    await sleep(T.quietMs + T.noticeMs + 1200);
    expect(events2).toEqual([]);
    expect(await c2.call('claude.autoresume.state', {})).toBeNull();
    const screen = ((await c2.call('session.snapshot', {})) as { data: string }).data; // (the screen from before the restart is part of it)
    expect(screen).not.toContain(`RESUMED: --resume ${QUIT}`);
    expect(screen).not.toContain(`RESUMED: --resume ${ENDED}`);
    expect(await c2.call('claude.resume', {})).toBeNull();
    c2.close();
  }, 40_000);

  it('a Claude that keeps crashing is tried three times with longer waits, then it gives up once and leaves the button', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-00000000000f';
    const { c, hook } = await inFolder5('auto-f');
    const events = track(c);
    const term = terminal(c);
    const cmds = commands(c);
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    fake.exitWith(1);
    await c.call('pty.write', { data: 'claude\r' }); // it crashes, and so does every resumed one
    await waitUntil(() => events.some((e) => e.state === 'gave-up'), 30_000);
    expect(states(events)).toEqual(['pending', 'typed', 'pending', 'typed', 'pending', 'typed', 'gave-up']);
    expect(events.every((e) => e.id === ID)).toBe(true);
    // each notice announced the wait for its attempt: 3 s, 20 s, 2 min in real life
    const notices = events.filter((e) => e.state === 'pending').map((e) => e.typesAt! - e.seenAt);
    for (const [i, n] of notices.entries()) expect(n).toBeGreaterThanOrEqual(T.waitsMs[i]! - 200);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(3);
    expect(cmds.filter((x) => x.cmd === `claude --resume ${ID}`).map((x) => x.exit)).toEqual([1, 1, 1]);
    // and no more: neither typing nor another notice, also over later prompts
    await c.call('pty.write', { data: 'echo after-give-up\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'echo after-give-up'), 8000);
    await sleep(T.quietMs + T.waitsMs[2]! + 1000);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(3);
    expect(states(events).filter((s) => s === 'gave-up')).toHaveLength(1);
    expect(states(events)).toHaveLength(7);
    expect((await c.call('claude.resume', {}))?.id).toBe(ID); // the button stays
    // restarting the shell (or typing `exit`) is not a new episode: nothing is tried, and it does not say it gave up again
    const before = (await c.call('pane.list', {}))[0];
    await c.call('session.restart', {});
    await waitUntil(async () => {
      const p = (await c.call('pane.list', {}))[0];
      return p.alive && p.pid !== before.pid;
    }, 10_000);
    await sleep(800 + T.quietMs + T.waitsMs[2]!); // past the new shell's first prompt and any wait
    expect(states(events).filter((s) => s === 'gave-up')).toHaveLength(1);
    expect(states(events)).toHaveLength(7);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(3);
    fake.exitWith(0);
    await c.call('claude.resume.dismiss', {});
    c.close();
  }, 60_000);

  it('the person typing comes first: right after they typed it waits, and a half-typed line is never added to', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-000000000010';
    const { c, hook } = await inFolder5('auto-g');
    const events = track(c);
    const term = terminal(c);
    const cmds = commands(c);
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    fake.exitWith(1);
    const typedAt = Date.now();
    await c.call('pty.write', { data: 'claude\r' }); // a crash, with the person's keystrokes just before the prompt
    await waitUntil(() => cmds.some((x) => x.cmd === 'claude' && x.exit === 1), 8000);
    fake.exitWith(0);
    await waitUntil(() => events.some((e) => e.state === 'pending'), 10_000);
    expect(events[0]!.seenAt - typedAt).toBeGreaterThanOrEqual(T.quietMs); // not before they had been quiet for a moment
    // during the notice they start a command of their own: nothing is typed after it
    await c.call('pty.write', { data: 'echo half' });
    await waitUntil(() => events.some((e) => e.state === 'cancelled'), 5000);
    await sleep(T.noticeMs + 500);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
    await c.call('pty.write', { data: ' done\r' });
    await waitUntil(() => cmds.some((x) => x.cmd.startsWith('echo half')), 8000);
    expect(cmds.find((x) => x.cmd.startsWith('echo half'))).toMatchObject({ cmd: 'echo half done', exit: 0 }); // their line, as they typed it
    // typing during the notice said no, as Cancel does: the clean prompts after their commands stay quiet, and the button is left
    await sleep(T.quietMs + T.noticeMs + 800);
    await c.call('pty.write', { data: 'echo next\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'echo next'), 8000);
    await sleep(T.quietMs + T.noticeMs + 800);
    expect(states(events)).toEqual(['pending', 'cancelled']);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
    expect((await c.call('claude.resume', {}))?.id).toBe(ID);
    // Claude crashes again later (a run ended, so what was said before is history): told first, typed once the time it announced had come
    fake.exitWith(1);
    await c.call('pty.write', { data: 'claude\r' });
    await waitUntil(() => cmds.filter((x) => x.cmd === 'claude' && x.exit === 1).length >= 2, 8000);
    fake.exitWith(0);
    term.watch(`RESUMED: --resume ${ID}`);
    await waitUntil(() => term.count(`RESUMED: --resume ${ID}`) > 0, 10_000);
    expect(states(events)).toEqual(['pending', 'cancelled', 'pending', 'typed']);
    const notice = events[2]!;
    expect(notice.typesAt! - notice.seenAt).toBeGreaterThanOrEqual(T.noticeMs - 200);
    expect(term.seenAt(`RESUMED: --resume ${ID}`)!).toBeGreaterThanOrEqual(notice.typesAt!); // (one clock: one machine)
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(1);
    expect(await c.call('claude.autoresume.state', {})).toBeNull();
    c.close();
  }, 40_000);

  it('Quit and End Session forgets the conversation, so nothing comes back; a plain shutdown (an update) keeps it', async () => {
    const ENDED = '1a2b3c4d-0000-4a00-8a00-000000000012';
    const KEPT = '1a2b3c4d-0000-4a00-8a00-000000000013';
    const file = path.join(env5.paths.sessionDir, 'claude.json');
    const { c, hook } = await inFolder5('auto-i');
    fake.exitWith(0);
    await hook(c, 'SessionStart', ENDED);
    await hook(c, 'UserPromptSubmit', ENDED, { prompt: 'go' });
    await waitUntil(() => fs.existsSync(file), 8000);
    await sleep(300);
    await c.call('app.shutdown', { forgetConversation: true }); // what the End Session menu item sends
    await waitUntil(async () => !(await tryConnect(env5.paths, 300)), 8000);
    expect(fs.existsSync(file)).toBe(false);
    const c2 = await connect5();
    const events = track(c2);
    await waitUntil(async () => (await c2.call('pane.list', {}))[0].alive);
    await sleep(800 + T.quietMs + T.noticeMs);
    expect(events).toEqual([]);
    expect(await c2.call('claude.autoresume.state', {})).toBeNull();
    expect(await c2.call('claude.resume', {})).toBeNull();
    expect(((await c2.call('session.snapshot', {})) as { data: string }).data).not.toContain(`RESUMED: --resume ${ENDED}`);
    // an update (or Restart session) shuts down plainly: the conversation is kept, and comes back
    await hook(c2, 'SessionStart', KEPT);
    await hook(c2, 'UserPromptSubmit', KEPT, { prompt: 'go' });
    await waitUntil(() => fs.existsSync(file), 8000);
    await sleep(300);
    await c2.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env5.paths, 300)), 8000);
    expect(fs.existsSync(file)).toBe(true);
    const c3 = await connect5();
    await waitUntil(async () => ((await c3.call('session.snapshot', {})) as { data: string }).data.includes(`RESUMED: --resume ${KEPT}`), 15_000);
    c3.close();
  }, 40_000);

  it('a `claude -p` that fails is a one-shot, not a conversation: nothing is kept and nothing is typed', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-000000000014';
    const file = path.join(env5.paths.sessionDir, 'claude.json');
    const { c, hook } = await inFolder5('auto-j');
    const events = track(c);
    const term = terminal(c);
    const cmds = commands(c);
    await hook(c, 'SessionStart', ID); // its own hooks fire too
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'hi' });
    await waitUntil(() => fs.existsSync(file), 8000);
    fake.exitWith(1);
    await c.call('pty.write', { data: 'claude -p hi\r' });
    await waitUntil(() => cmds.some((x) => x.cmd === 'claude -p hi' && x.exit === 1), 8000);
    await sleep(T.quietMs + T.noticeMs + 800);
    expect(fs.existsSync(file)).toBe(false);
    expect(events).toEqual([]);
    expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
    expect(await c.call('claude.resume', {})).toBeNull();
    fake.exitWith(0);
    c.close();
  }, 40_000);

  it('a `claude -p` still running when its shell goes (an update, a crash, Restart shell) is a one-shot too: its hooks keep nothing, and nothing is typed afterwards', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-000000000015';
    const file = path.join(env5.paths.sessionDir, 'claude.json');
    const { c, hook } = await inFolder5('auto-k');
    await c.call('claude.resume.dismiss', {}); // nothing kept from before
    const events = track(c);
    const term = terminal(c);
    const starts = collect(c, 'pty.start') as { cmd: string }[];
    try {
      fake.sleeps(20); // a long print-mode run
      await c.call('pty.write', { data: 'claude -p "summarise the log"\r' });
      await waitUntil(() => starts.some((x) => x.cmd.startsWith('claude -p')), 8000);
      await hook(c, 'SessionStart', ID); // its own hooks fire, as any Claude's do
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'summarise the log' });
      await sleep(300);
      expect(fs.existsSync(file)).toBe(false);
      const before = (await c.call('pane.list', {}))[0];
      await c.call('session.restart', {}); // the shell goes, and the run with it
      await waitUntil(async () => {
        const p = (await c.call('pane.list', {}))[0];
        return p.alive && p.pid !== before.pid;
      }, 10_000);
      await sleep(800 + T.quietMs + T.noticeMs + 800); // past the new shell's first prompt and a notice it would have had
      expect(events).toEqual([]);
      expect(term.count(`RESUMED: --resume ${ID}`)).toBe(0);
      expect(await c.call('claude.resume', {})).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fake.sleeps(0);
      c.close();
    }
  }, 40_000);

  it('a shell that dies with Claude in it brings Claude back in the new shell, even after an earlier Cancel', async () => {
    const ID = '1a2b3c4d-0000-4a00-8a00-000000000011';
    const { c, hook } = await inFolder5('auto-h');
    const events = track(c);
    const term = terminal(c);
    await hook(c, 'SessionStart', ID);
    await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
    fake.exitWith(1);
    await c.call('pty.write', { data: 'claude\r' }); // a crash, and the person says not now
    await waitUntil(() => events.some((e) => e.state === 'pending'), 10_000);
    await c.call('claude.autoresume.cancel', {});
    await waitUntil(() => events.some((e) => e.state === 'cancelled'), 5000);
    await hook(c, 'SessionStart', ID); // later they resume it by hand, and it runs
    await waitUntil(async () => (await c.call('claude.resume', {})) === null, 5000);
    fake.exitWith(0);
    const before = (await c.call('pane.list', {}))[0];
    await c.call('session.restart', {}); // the palette's Restart shell: the shell dies, and Claude with it
    await waitUntil(async () => {
      const p = (await c.call('pane.list', {}))[0];
      return p.alive && p.pid !== before.pid;
    }, 10_000);
    await waitUntil(() => term.count(`RESUMED: --resume ${ID}`) > 0, 15_000);
    expect(states(events)).toEqual(['pending', 'cancelled', 'pending', 'typed']);
    c.close();
  }, 40_000);

  // Restart Claude Code (the palette, Settings): the shell restarts in the same folder and the same conversation comes back
  describe('Restart Claude (claude.restart.plan, claude.restart)', () => {
    const tag = (n: number) => `1a2b3c4d-0000-4a00-8a00-0000000001${String(n).padStart(2, '0')}`;
    type Hook = Awaited<ReturnType<typeof inFolder5>>['hook'];
    /** Nothing from an earlier test is still running as far as the daemon knows. */
    const endSessions = async (c: RpcClient, hook: Hook) => {
      for (const s of (await c.call('claude.state', {})).sessions) if (s.state !== 'ended') await hook(c, 'SessionEnd', s.id);
    };
    const panePid = async (c: RpcClient) => (await c.call('pane.list', {}))[0].pid as number;
    /** The shell that replaces the one with this pid, alive. */
    const newShell = async (c: RpcClient, before: number) => {
      await waitUntil(async () => {
        const p = (await c.call('pane.list', {}))[0];
        return p.alive && p.pid !== before;
      }, 10_000);
      return (await c.call('pane.list', {}))[0] as { pid: number };
    };
    const folderOf = async (c: RpcClient) => fs.realpathSync((await c.call('session.info', {})).cwd);
    const plan = (c: RpcClient) => c.call('claude.restart.plan', {});
    const setSession = (c: RpcClient, session: object) => c.call('config.patch', { session });
    const resumed = (id: string) => `RESUMED: --resume ${id}`;
    const settle = () => sleep(T.quietMs + T.noticeMs + 900);
    /** A conversation whose Claude crashed in this shell: no session is open any more, the offer is there (and auto-resume is off). */
    const crashedConversation = async (c: RpcClient, hook: Hook, id: string) => {
      const cmds = commands(c);
      await hook(c, 'SessionStart', id);
      fake.exitWith(1);
      await c.call('pty.write', { data: 'claude\r' });
      await waitUntil(() => cmds.some((x) => x.cmd === 'claude' && x.exit === 1), 8000);
      fake.exitWith(0);
      await waitUntil(async () => (await c.call('claude.resume', {}))?.id === id, 8000);
    };
    afterEach(() => {
      fake.startsAfter(0);
      fake.waitsForALine(0);
      fake.sleeps(0);
    });

    it('the plan says whether a conversation would come back and whether it is working, and restarts nothing', async () => {
      const ID = tag(1);
      const { c, hook } = await inFolder5('rs-plan');
      await endSessions(c, hook);
      const pid = await panePid(c);
      expect(await plan(c)).toEqual({ resumable: false, busy: false }); // nothing recorded here
      await hook(c, 'SessionStart', ID);
      expect(await plan(c)).toEqual({ resumable: true, busy: false }); // a Claude that is open and idle
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      expect(await plan(c)).toEqual({ resumable: true, busy: true }); // working
      await hook(c, 'Stop', ID);
      expect(await plan(c)).toEqual({ resumable: true, busy: false });
      await hook(c, 'PreToolUse', ID, { tool_name: 'Bash', tool_use_id: 'toolu_1' });
      await hook(c, 'Notification', ID, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
      expect(await plan(c)).toEqual({ resumable: true, busy: true }); // waiting for the person counts too
      await c.call('claude.resume.dismiss', {}); // "Not now": the conversation is forgotten, nothing to bring back
      expect(await plan(c)).toEqual({ resumable: false, busy: true }); // (the Claude that is open still waits for the person)
      await hook(c, 'SessionEnd', ID);
      expect(await plan(c)).toEqual({ resumable: false, busy: false });
      expect(await panePid(c)).toBe(pid); // and asking restarted nothing
      c.close();
    }, 30_000);

    it('restarts the shell in the same folder and resumes the same conversation, also with "Resume Claude automatically" off', async () => {
      const ID = tag(2);
      const { c, real, hook } = await inFolder5('rs-a');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        await hook(c, 'SessionStart', ID);
        await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' }); // working when it is restarted
        expect(await plan(c)).toEqual({ resumable: true, busy: true });
        const before = await panePid(c);
        const at = Date.now();
        expect(await c.call('claude.restart', {})).toEqual({ resumable: true });
        const shell = await newShell(c, before);
        expect(shell.pid).not.toBe(before);
        expect(await folderOf(c)).toBe(real); // the same folder
        await waitUntil(() => term.count(resumed(ID)) > 0, 15_000);
        // announced first, typed once the time it said had come, exactly that line
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(events[0]!.id).toBe(ID);
        expect(events[0]!.typesAt! - events[0]!.seenAt).toBeGreaterThanOrEqual(T.noticeMs - 200);
        expect(events[0]!.seenAt).toBeGreaterThan(at);
        expect(((await c.call('session.snapshot', {})) as { data: string }).data).toContain(`claude --resume ${ID}`);
        await settle();
        expect(term.count(resumed(ID))).toBe(1); // once
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(await c.call('claude.autoresume.state', {})).toBeNull();
        // it was a request for that once: nothing automatic follows (the setting is still off)
        expect((await c.call('config.get', {})).session.autoResume).toBe(false);
        expect(await c.call('claude.resume', {})).toBeNull(); // the stand-in quit on purpose
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('works the same with "Resume Claude automatically" on, and counts as one attempt', async () => {
      const ID = tag(3);
      const { c, hook } = await inFolder5('rs-b');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      fake.exitWith(1); // the resumed one crashes: a restart counts as a try, the next waits longer
      await hook(c, 'SessionStart', ID);
      const before = await panePid(c);
      expect(await c.call('claude.restart', {})).toEqual({ resumable: true });
      await newShell(c, before);
      await waitUntil(() => term.count(resumed(ID)) > 0, 15_000);
      expect(states(events).slice(0, 2)).toEqual(['pending', 'typed']);
      // its crash is tried again after the second wait, not the first: the restart was the first try
      await waitUntil(() => events.filter((e) => e.state === 'pending').length >= 2, 10_000);
      const second = events.filter((e) => e.state === 'pending')[1]!;
      expect(second.typesAt! - second.seenAt).toBeGreaterThanOrEqual(T.waitsMs[1]! - 200);
      fake.exitWith(0);
      await waitUntil(() => term.count(resumed(ID)) >= 2, 10_000);
      await settle();
      await c.call('claude.resume.dismiss', {});
      c.close();
    }, 40_000);

    it('Cancel during the notice types nothing and leaves the button', async () => {
      const ID = tag(4);
      const { c, hook } = await inFolder5('rs-c');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        await waitUntil(() => events.some((e) => e.state === 'pending'), 10_000);
        expect(await c.call('claude.autoresume.cancel', {})).toBe(true);
        await waitUntil(() => events.some((e) => e.state === 'cancelled'), 5000);
        await settle();
        expect(term.count(resumed(ID))).toBe(0);
        expect(states(events)).toEqual(['pending', 'cancelled']);
        expect((await c.call('claude.resume', {}))?.id).toBe(ID); // the button is still there
        // and a later prompt does not bring it back
        await c.call('pty.write', { data: 'echo after-cancel\r' });
        await sleep(T.quietMs + T.noticeMs + 800);
        expect(term.count(resumed(ID))).toBe(0);
        expect(states(events)).toEqual(['pending', 'cancelled']);
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('with no conversation it only restarts the shell, in the same folder, and types nothing', async () => {
      const { c, real, hook } = await inFolder5('rs-d');
      await endSessions(c, hook);
      await c.call('claude.resume.dismiss', {});
      const events = track(c);
      const term = terminal(c);
      expect(await plan(c)).toEqual({ resumable: false, busy: false });
      const before = await panePid(c);
      expect(await c.call('claude.restart', {})).toEqual({ resumable: false });
      await newShell(c, before);
      expect(await folderOf(c)).toBe(real);
      await settle();
      expect(events).toEqual([]);
      expect(term.text()).not.toContain('RESUMED:');
      expect(await c.call('claude.resume', {})).toBeNull();
      c.close();
    }, 30_000);

    it('with "Offer to resume Claude Code" off nothing is kept, so it only restarts the shell and never types', async () => {
      const ID = tag(5);
      const { c, hook } = await inFolder5('rs-e');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await hook(c, 'SessionStart', ID);
      expect(await plan(c)).toEqual({ resumable: true, busy: false });
      await setSession(c, { resumeClaude: false }); // switching it off forgets the conversation
      try {
        await hook(c, 'SessionStart', ID); // and a Claude that is still open is not recorded again
        expect(await plan(c)).toEqual({ resumable: false, busy: false });
        const before = await panePid(c);
        expect(await c.call('claude.restart', {})).toEqual({ resumable: false });
        await newShell(c, before);
        await settle();
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect(await c.call('claude.resume', {})).toBeNull();
        // switched on again later, nothing is left over from the request
        await setSession(c, { resumeClaude: true });
        await sleep(T.quietMs + T.noticeMs + 600);
        expect(term.text()).not.toContain('RESUMED:');
      } finally {
        await setSession(c, { resumeClaude: true });
        c.close();
      }
    }, 40_000);

    it('waits for the new shell: a first prompt that comes later than the request still gets the conversation back', async () => {
      const ID = tag(6);
      const { c, hook } = await inFolder5('rs-f');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(1.5); // the person's startup file keeps the new shell from its prompt for a while
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        const at = Date.now();
        await c.call('claude.restart', {});
        await newShell(c, before);
        await sleep(600);
        expect(events).toEqual([]); // nothing yet: no prompt, and nothing typed into a shell that is still starting
        await waitUntil(() => term.count(resumed(ID)) > 0, 20_000);
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(events[0]!.seenAt - at).toBeGreaterThanOrEqual(1500); // it was announced at that prompt, not at the request
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('a second request while the first one is announced replaces it: the new shell is resumed once', async () => {
      const ID = tag(7);
      const { c, hook } = await inFolder5('rs-g');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        await hook(c, 'SessionStart', ID);
        const first = await panePid(c);
        // asked again the moment the notice for the second shell is announced (it runs for T.noticeMs)
        let again: Promise<unknown> | undefined;
        c.on('claude.autoresume', (d) => {
          if (d.state === 'pending' && !again) again = c.call('claude.restart', {});
        });
        await c.call('claude.restart', {});
        await waitUntil(() => term.count(resumed(ID)) > 0, 15_000);
        expect(await again).toEqual({ resumable: true });
        expect(await panePid(c)).not.toBe(first);
        // the first notice died with its shell; the third shell is announced and resumed, by the request (the setting is off)
        expect(states(events)).toEqual(['pending', 'cancelled', 'pending', 'typed']);
        await settle();
        expect(term.count(resumed(ID))).toBe(1);
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('a request that was not answered in time is stale: a prompt that comes later types nothing', async () => {
      const ID = tag(8);
      const { c, hook } = await inFolder5('rs-h');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(RESTART_HOLD_TEST_MS / 1000 + 2); // the shell reaches its prompt after the daemon stopped waiting for it
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        await sleep(RESTART_HOLD_TEST_MS + 3000); // (its prompt comes 2 s after the daemon stopped waiting)
        await settle(); // and long enough for anything that prompt set off
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect((await c.call('claude.resume', {}))?.id).toBe(ID); // only the button is left
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('at the attempt limit Restart Claude still resumes: the limit is for crash loops nobody asked for, and the notice is the short one', async () => {
      const ID = tag(9);
      const { c, hook } = await inFolder5('rs-i');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      await hook(c, 'SessionStart', ID);
      await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
      fake.exitWith(1);
      await c.call('pty.write', { data: 'claude\r' }); // it crashes, and so does every resumed one
      await waitUntil(() => events.some((e) => e.state === 'gave-up'), 30_000);
      expect(term.count(resumed(ID))).toBe(3);
      expect(states(events).filter((x) => x === 'gave-up')).toHaveLength(1);
      expect(cmds.filter((x) => x.cmd === `claude --resume ${ID}`)).toHaveLength(3);
      // the person asks for Restart Claude anyway: the attempts start over, it is announced after the short notice (not the third retry's
      // longer wait) and typed
      fake.exitWith(0);
      expect(await plan(c)).toEqual({ resumable: true, busy: false });
      const before = await panePid(c);
      const seen = events.length;
      expect(await c.call('claude.restart', {})).toEqual({ resumable: true });
      await newShell(c, before);
      await waitUntil(() => term.count(resumed(ID)) === 4, 15_000);
      const request = events.slice(seen);
      expect(states(request)).toEqual(['pending', 'typed']);
      expect(request[0]!.typesAt! - request[0]!.seenAt).toBeLessThanOrEqual(T.noticeMs + 20);
      expect(T.waitsMs[2]).toBeGreaterThan(T.noticeMs + 100); // (so that the check above tells the two waits apart)
      expect(states(events).filter((x) => x === 'gave-up')).toHaveLength(1); // told once, as before
      await settle();
      expect(term.count(resumed(ID))).toBe(4);
      expect(await c.call('claude.autoresume.state', {})).toBeNull();
      await c.call('claude.resume.dismiss', {});
      c.close();
    }, 60_000);

    it("the palette's plain Restart shell leaves the conversation to the button and asks for nothing by itself", async () => {
      const ID = tag(10);
      const { c, hook } = await inFolder5('rs-j');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        await hook(c, 'SessionStart', ID);
        await hook(c, 'UserPromptSubmit', ID, { prompt: 'go' });
        const before = await panePid(c);
        await c.call('session.restart', {}); // (Restart shell: the shell dies, and Claude with it)
        await newShell(c, before);
        await waitUntil(async () => (await c.call('claude.resume', {}))?.id === ID, 10_000);
        await settle();
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect((await c.call('claude.resume', {}))?.id).toBe(ID);
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    // What the person types is theirs: a keystroke that reached the shell after it was spawned, or after the last command began, sits
    // in its line, and nothing is added to it (bash and zsh put keys typed during startup or while a command runs on the next prompt).
    it('keys typed while the new shell is still starting are never added to: Restart Claude leaves the line the person\'s and the button as it was', async () => {
      const ID = tag(11);
      const { c, hook } = await inFolder5('rs-k');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(1.5);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        await c.call('pty.write', { data: 'echo ty' }); // while the startup file sleeps: it waits in the shell's line
        await sleep(RESTART_HOLD_TEST_MS + 1500); // the prompt comes at 1.5 s, and the request waits out its time
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect(term.text()).not.toContain('claude --resume');
        expect((await c.call('claude.resume', {}))?.id).toBe(ID); // still the button
        await c.call('pty.write', { data: '\r' });
        await waitUntil(() => cmds.some((x) => x.cmd.startsWith('echo ty')), 8000);
        expect(cmds.find((x) => x.cmd.startsWith('echo ty'))).toMatchObject({ cmd: 'echo ty', exit: 0 }); // exactly what they typed
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('the same for the automatic resume after a plain Restart shell; once their command has run the line is clean and it goes ahead', async () => {
      const ID = tag(12);
      const { c, hook } = await inFolder5('rs-l');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      fake.exitWith(0);
      fake.startsAfter(1.5);
      await hook(c, 'SessionStart', ID);
      const before = await panePid(c);
      await c.call('session.restart', {});
      await newShell(c, before);
      await c.call('pty.write', { data: 'echo ty' });
      await sleep(1500 + T.quietMs + T.noticeMs + 1500); // past the prompt, the quiet moment and the notice it would have had
      expect(events).toEqual([]);
      expect(term.text()).not.toContain('RESUMED:');
      expect((await c.call('claude.resume', {}))?.id).toBe(ID);
      await c.call('pty.write', { data: '\r' });
      await waitUntil(() => cmds.some((x) => x.cmd.startsWith('echo ty')), 8000);
      expect(cmds.find((x) => x.cmd.startsWith('echo ty'))).toMatchObject({ cmd: 'echo ty', exit: 0 });
      // their command ran, so the prompt after it is clean again: now it goes ahead, as a line of its own
      await waitUntil(() => term.count(resumed(ID)) > 0, 10_000);
      expect(states(events)).toEqual(['pending', 'typed']);
      expect(cmds.some((x) => x.cmd.includes('echo ty') && x.cmd.includes('--resume'))).toBe(false);
      c.close();
    }, 40_000);

    it('keys typed ahead while a command runs make the prompt after it dirty: nothing is added to them', async () => {
      const ID = tag(13);
      const { c, hook } = await inFolder5('rs-m');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      const starts = collect(c, 'pty.start') as { cmd: string }[];
      await setSession(c, { autoResume: false });
      try {
        await crashedConversation(c, hook, ID);
        await c.call('pty.write', { data: 'sleep 2\r' });
        await waitUntil(() => starts.some((x) => x.cmd === 'sleep 2'), 8000);
        await c.call('pty.write', { data: 'echo ahead' }); // typed ahead, while it runs
        await setSession(c, { autoResume: true }); // (a command runs: nothing yet)
        await waitUntil(() => cmds.some((x) => x.cmd === 'sleep 2'), 8000);
        await sleep(T.quietMs + T.noticeMs + 1200);
        expect(events).toEqual([]);
        expect(term.count(resumed(ID))).toBe(0);
        expect((await c.call('claude.resume', {}))?.id).toBe(ID);
        await c.call('pty.write', { data: '\r' });
        await waitUntil(() => cmds.some((x) => x.cmd.startsWith('echo ahead')), 8000);
        expect(cmds.find((x) => x.cmd.startsWith('echo ahead'))).toMatchObject({ cmd: 'echo ahead', exit: 0 });
        await waitUntil(() => term.count(resumed(ID)) > 0, 10_000); // and once theirs has run, it is clean again
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(cmds.some((x) => x.cmd.includes('echo ahead') && x.cmd.includes('--resume'))).toBe(false);
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('keys that were a command are not a started line: after one has run the prompt is clean and the automatic resume goes ahead', async () => {
      const ID = tag(17);
      const { c, hook } = await inFolder5('rs-q');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      await setSession(c, { autoResume: false });
      try {
        await crashedConversation(c, hook, ID);
        await c.call('pty.write', { data: 'echo ran\r' }); // typed and run before the next prompt
        await waitUntil(() => cmds.some((x) => x.cmd === 'echo ran'), 8000);
        await sleep(300);
        expect(events).toEqual([]);
        await setSession(c, { autoResume: true }); // at that prompt, with nothing in its line
        await waitUntil(() => term.count(resumed(ID)) > 0, 10_000);
        expect(states(events)).toEqual(['pending', 'typed']);
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it("what is typed into a running Claude is Claude's own: when it crashes afterwards the conversation is still resumed by itself", async () => {
      const ID = tag(20);
      const { c, hook } = await inFolder5('rs-s');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      const starts = collect(c, 'pty.start') as { cmd: string }[];
      await hook(c, 'SessionStart', ID);
      fake.waitsForALine(6); // Claude waits for what the person types
      fake.exitWith(1);
      await c.call('pty.write', { data: 'claude\r' });
      await waitUntil(() => starts.some((x) => x.cmd === 'claude'), 8000);
      await c.call('pty.write', { data: 'fix the build\r' }); // their prompt, read by Claude; it crashes on it
      await waitUntil(() => cmds.some((x) => x.cmd === 'claude' && x.exit === 1), 8000);
      fake.waitsForALine(0);
      fake.exitWith(0); // the resumed one runs and is quit on purpose
      await waitUntil(() => term.count(resumed(ID)) > 0, 10_000);
      expect(states(events)).toEqual(['pending', 'typed']);
      c.close();
    }, 40_000);

    it('keys typed ahead while `claude update` or `claude --version` runs are the shell\'s, not Claude\'s: the prompt after it stays dirty and nothing is added', async () => {
      const { c, hook } = await inFolder5('rs-t');
      await endSessions(c, hook);
      const term = terminal(c);
      const cmds = commands(c);
      const starts = collect(c, 'pty.start') as { cmd: string }[];
      await setSession(c, { autoResume: false });
      try {
        for (const [n, sub] of ['update', '--version'].entries()) {
          const ID = tag(21 + n);
          const events = track(c);
          const line = `claude ${sub}`;
          await setSession(c, { autoResume: false });
          await crashedConversation(c, hook, ID);
          fake.sleeps(2); // it reads nothing from the terminal while it runs
          await c.call('pty.write', { data: `${line}\r` });
          await waitUntil(() => starts.some((x) => x.cmd === line), 8000);
          await c.call('pty.write', { data: 'echo ahead' }); // typed ahead: it waits in the shell's line
          await setSession(c, { autoResume: true }); // (a command runs: nothing yet)
          await waitUntil(() => cmds.some((x) => x.cmd === line), 8000);
          fake.sleeps(0);
          await sleep(T.quietMs + T.noticeMs + 1200);
          expect(events, line).toEqual([]);
          expect(term.count(resumed(ID)), line).toBe(0);
          expect((await c.call('claude.resume', {}))?.id, line).toBe(ID); // the conversation is still the button's
          await c.call('pty.write', { data: '\r' });
          await waitUntil(() => cmds.some((x) => x.cmd.startsWith('echo ahead') && x.exit === 0), 8000);
          expect(cmds.filter((x) => x.cmd.includes('echo ahead')).at(-1), line).toMatchObject({ cmd: 'echo ahead', exit: 0 }); // exactly theirs
          await waitUntil(() => term.count(resumed(ID)) > 0, 10_000); // theirs has run: clean again, and it goes ahead as a line of its own
          expect(states(events), line).toEqual(['pending', 'typed']);
          await settle();
        }
      } finally {
        fake.sleeps(0);
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 60_000);

    it('a different conversation that gets an offer while the new shell starts is not resumed for this request', async () => {
      const ID = tag(14);
      const OTHER = tag(15);
      const { c, hook } = await inFolder5('rs-n');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(1.5);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {}); // for ID
        await newShell(c, before);
        await hook(c, 'SessionStart', OTHER); // another conversation turns up, and is over (just after the shell's exit it keeps its point)
        await hook(c, 'SessionEnd', OTHER);
        await sleep(1500 + T.quietMs + T.noticeMs + 1500);
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect((await c.call('claude.resume', {}))?.id).toBe(OTHER); // the button, for that one
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('with the offer gone at the first prompt the request is over: a conversation that turns up later is not resumed for it', async () => {
      const ID = tag(18);
      const OTHER = tag(19);
      const { c, hook } = await inFolder5('rs-r');
      await endSessions(c, hook);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      const prompts = collect(c, 'pty.prompt');
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(1.5);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        const seen = prompts.length;
        await c.call('claude.resume.dismiss', {}); // "Not now" while the shell starts: no offer at its first prompt
        await waitUntil(() => prompts.length > seen, 10_000);
        await hook(c, 'SessionStart', OTHER);
        await hook(c, 'SessionEnd', OTHER);
        await c.call('pty.write', { data: 'echo next\r' }); // a command, and the prompt after it
        await waitUntil(() => cmds.some((x) => x.cmd === 'echo next'), 8000);
        await sleep(T.quietMs + T.noticeMs + 1200);
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect((await c.call('claude.resume', {}))?.id).toBe(OTHER);
        await c.call('claude.resume.dismiss', {});
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('a daemon that stops while the request waits for the new shell types nothing for it, now or after it starts again', async () => {
      const ID = tag(16);
      const { c, hook } = await inFolder5('rs-o');
      await endSessions(c, hook);
      await setSession(c, { autoResume: false });
      let c2: RpcClient | undefined;
      try {
        fake.exitWith(0);
        fake.startsAfter(1.5);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        fake.startsAfter(0);
        c2 = await restart5(c); // a plain shutdown (an update) in the middle of the wait
        const events = track(c2);
        const term = terminal(c2);
        await c2.call('session.attach', { cols: 100, rows: 30 });
        await waitUntil(async () => (await c2!.call('pane.list', {}))[0].alive);
        await sleep(1000 + T.quietMs + T.noticeMs + 1500);
        expect(events).toEqual([]);
        expect(term.text()).not.toContain('RESUMED:');
        expect((await c2.call('claude.resume', {}))?.id).toBe(ID); // the conversation is kept: a button, as the setting says
        await c2.call('claude.resume.dismiss', {});
      } finally {
        const last = c2 ?? c;
        await setSession(last, { autoResume: true });
        last.close();
      }
    }, 40_000);

    // The marks are output, and a program can print them: what the daemon types must reach the shell itself, never a program it runs
    // (the shell's foreground process is looked at, not the marks), and the Resume button waits for that too.
    it('an ssh whose remote shell prints a prompt of its own is not the shell: nothing is typed into it, the button waits, and the shell\'s own prompt afterwards resumes', async () => {
      const ID = tag(30);
      const { c, hook } = await inFolder5('fg-a');
      await endSessions(c, hook);
      const ssh = standInSsh(fake.dir);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      await setSession(c, { autoResume: false });
      try {
        await crashedConversation(c, hook, ID); // the conversation is offered in this folder
        ssh.clear();
        ssh.staysFor(4);
        await c.call('pty.write', { data: 'ssh server\r' });
        // by the marks: ssh ended, a prompt, a command with no line ended, a prompt: nothing runs and the line is empty
        await waitUntil(() => cmds.some((x) => x.cmd === ''), 8000);
        await sleep(300);
        expect(await c.call('claude.resume', {})).toBeNull(); // no Resume button while ssh runs
        await setSession(c, { autoResume: true }); // (a check, at what the marks call a clean prompt)
        await sleep(T.quietMs + T.noticeMs + 1200);
        expect(ssh.got()).toBe(''); // nothing reached the remote shell
        expect(events).toEqual([]);
        expect(term.count(resumed(ID))).toBe(0);
        // ssh ends: the shell's own prompt, and the conversation comes back there
        await waitUntil(() => term.count(resumed(ID)) > 0, 15_000);
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(ssh.got()).toBe('');
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it('the same for Restart Claude: an ssh typed ahead into the new shell gets nothing at its remote prompt; the shell\'s own prompt after it is resumed', async () => {
      const ID = tag(31);
      const { c, hook } = await inFolder5('fg-b');
      await endSessions(c, hook);
      const ssh = standInSsh(fake.dir);
      const events = track(c);
      const term = terminal(c);
      const cmds = commands(c);
      await setSession(c, { autoResume: false });
      try {
        fake.exitWith(0);
        fake.startsAfter(1); // the new shell takes a second to its first prompt: what is typed meanwhile runs there
        ssh.clear();
        ssh.staysFor(2);
        await hook(c, 'SessionStart', ID);
        const before = await panePid(c);
        await c.call('claude.restart', {});
        await newShell(c, before);
        await c.call('pty.write', { data: 'ssh server\r' });
        await waitUntil(() => cmds.some((x) => x.cmd === ''), 8000); // the remote prompt
        await sleep(T.quietMs + T.noticeMs + 600);
        expect(ssh.got()).toBe('');
        expect(term.count(resumed(ID))).toBe(0);
        // ssh ends within the request's time: the new shell's own prompt brings the conversation back
        await waitUntil(() => term.count(resumed(ID)) > 0, 15_000);
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(ssh.got()).toBe('');
      } finally {
        await setSession(c, { autoResume: true });
        c.close();
      }
    }, 40_000);

    it("a program the person's own PROMPT_COMMAND runs just after the prompt mark only delays it: once the shell has the terminal it goes ahead", async () => {
      const ID = tag(32);
      const { c, hook } = await inFolder5('fg-c');
      await endSessions(c, hook);
      const cmds = commands(c);
      const prompts = collect(c, 'pty.prompt');
      // bash runs PROMPT_COMMAND after Jaffer's prompt mark: this one keeps a program in front of the shell for 1.2 s at every prompt
      await c.call('pty.write', { data: 'PROMPT_COMMAND="${PROMPT_COMMAND%;__jaffer_prompt_end};/bin/sleep 1.2;__jaffer_prompt_end"\r' });
      await waitUntil(() => cmds.some((x) => x.cmd.startsWith('PROMPT_COMMAND=')), 8000);
      await sleep(1600);
      const events = track(c);
      const term = terminal(c);
      let crashedAt = 0;
      c.on('pty.command', (d) => {
        if (d.cmd === 'claude' && d.exit === 1 && !crashedAt) crashedAt = Date.now();
      });
      try {
        const seen = prompts.length;
        await crashedConversation(c, hook, ID); // a crash: the prompt after it comes while that program runs
        await waitUntil(() => term.count(resumed(ID)) > 0, 10_000);
        expect(prompts.length).toBeGreaterThan(seen);
        expect(states(events)).toEqual(['pending', 'typed']);
        expect(events[0]!.seenAt - crashedAt).toBeGreaterThanOrEqual(1000); // announced once the shell had the terminal back
      } finally {
        await c.call('pty.write', { data: 'PROMPT_COMMAND="${PROMPT_COMMAND//;\\/bin\\/sleep 1.2/}"\r' });
        await waitUntil(() => cmds.filter((x) => x.cmd.startsWith('PROMPT_COMMAND=')).length >= 2, 8000);
        c.close();
      }
    }, 40_000);
  });
});

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
        env: { HOME: env4.userHome, SHELL: '/bin/bash', JAFFER_TICK_MS: '400', PS1: '$ ' },
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
      env: { HOME: env6.userHome, SHELL: '/bin/bash', JAFFER_TICK_MS: '400', PS1: '$ ', JAFFER_TEST_HOLD_LOG: log() },
    });
    pid = (await c.call('hello', {})).pid;
    await c.call('config.patch', { session: { autoResume: false } }); // nothing in this block may type into the shell
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

describe('the exit code of the daemon tells launchd whether to bring it back (bundled daemon, started and watched here)', () => {
  /** Start the bundled daemon in a home of its own and wait until it answers. `exited` resolves with how it ended. */
  async function start(e: TestEnv) {
    fs.writeFileSync(path.join(e.userHome, '.zshenv'), 'skip_global_compinit=1\n');
    const child = spawn(process.execPath, [path.join(root, 'dist/daemon/jafferd.cjs')], {
      env: { ...process.env, HOME: e.userHome, JAFFER_HOME: e.home, SHELL: '/bin/bash', PS1: '$ ', JAFFER_TICK_MS: '400' },
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
  const savedAt = (e: TestEnv): number => Date.parse(JSON.parse(fs.readFileSync(e.paths.sessionState, 'utf8')).savedAt);

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('%s ends it with code %i (so launchd brings it back), after the state was saved', async (signal, code) => {
    const e = makeEnv();
    try {
      const { child, exited, c } = await start(e);
      await c.call('session.attach', { cols: 100, rows: 30 });
      await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
      c.close();
      await sleep(600);
      const sent = Date.now();
      child.kill(signal);
      const ended = await exited;
      expect(ended).toEqual({ code, signal: null });
      expect(savedAt(e)).toBeGreaterThanOrEqual(sent); // written while stopping, not by the periodic save before the signal
      expect(fs.existsSync(e.paths.socket)).toBe(false); // and it let go of the socket
    } finally {
      e.cleanup();
    }
  }, 40_000);

  it('app.shutdown (a deliberate end: End Session, an update, Reset) still ends it with code 0, which launchd leaves alone', async () => {
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

  it('the first reason to stop wins: more signals while it stops neither cut the save short nor change the code, and a SIGTERM during app.shutdown keeps 0', async () => {
    const e = makeEnv();
    try {
      const { child, exited, c } = await start(e);
      await c.call('session.attach', { cols: 100, rows: 30 });
      await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
      c.close();
      await sleep(600);
      const sent = Date.now();
      child.kill('SIGTERM');
      for (const ms of [5, 20, 40]) {
        await sleep(ms);
        if (child.exitCode === null) child.kill(ms === 20 ? 'SIGINT' : 'SIGTERM');
      }
      expect(await exited).toEqual({ code: 143, signal: null });
      expect(savedAt(e)).toBeGreaterThanOrEqual(sent); // the first stop finished saving before the process ended
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
      expect(await exited).toEqual({ code: 0, signal: null }); // the person ended it: launchd must not bring it back
      c.close();
    } finally {
      e2.cleanup();
    }
  }, 60_000);
});

describe('the login agent in a test home: refused, and nothing is touched (bundled daemon and CLI)', () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, JAFFER_HOME: env.home }, encoding: 'utf8', cwd: env.userHome });
  const agentsDir = () => path.join(env.userHome, 'Library', 'LaunchAgents');
  /** Why: this is not the person's own ~/.jaffer (or, off macOS, not a Mac). */
  const REASON = /~\/\.jaffer|another folder|macOS only/;

  it("service.status, service.install and service.remove say why, leave the switch off, and create nothing under the user's Library/LaunchAgents", async () => {
    const c = await connect();
    for (const m of ['service.status', 'service.install', 'service.remove', 'service.status']) {
      expect(await c.call(m, {}), m).toEqual({ state: 'refused', reason: expect.stringMatching(REASON) });
    }
    expect((await c.call('config.get', {})).session.keepRunning).toBe(false);
    expect(fs.existsSync(agentsDir())).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'bin', 'jafferd'))).toBe(false); // no wrapper either
  });

  it('`jaffer service status` prints the refusal in words, `jaffer service install` exits non-zero with the reason, and the group has a usage', async () => {
    const st = cli('service', 'status');
    expect(st.status, st.stderr).toBe(0);
    expect(st.stdout).toMatch(/refused: /);
    expect(st.stdout).toMatch(REASON);
    expect(cli('service').stdout).toMatch(/refused: /); // status is what it shows by default
    const inst = cli('service', 'install');
    expect(inst.status).not.toBe(0);
    expect(inst.stderr).toMatch(REASON);
    const rm = cli('service', 'remove');
    expect(rm.stdout + rm.stderr).toMatch(REASON);
    const help = cli('service', '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/jaffer service install/);
    expect(help.stdout).toMatch(/remove/);
    const bad = cli('service', 'frobnicate');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/Usage: jaffer service/);
    expect(cli('--help').stdout).toMatch(/jaffer service/);
    expect(fs.existsSync(agentsDir())).toBe(false);
    expect((await (await connect()).call('config.get', {})).session.keepRunning).toBe(false);
  }, 30_000);

  it('`jaffer service remove` needs no daemon: with none answering it starts none and takes the agent away itself (in this test home: refused, and nothing is touched, not even the switch)', async () => {
    const e2 = makeEnv(); // a home whose daemon is not running (or cannot start)
    const cli2 = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, HOME: e2.userHome, JAFFER_HOME: e2.home }, encoding: 'utf8', cwd: e2.userHome, timeout: 30_000 });
    try {
      fs.mkdirSync(e2.home, { recursive: true });
      fs.writeFileSync(e2.paths.config, JSON.stringify({ onboarded: true, session: { keepRunning: true } }));
      const t0 = Date.now();
      const rm = cli2('service', 'remove');
      expect(rm.status, rm.stderr).toBe(0);
      expect(rm.stdout + rm.stderr).toMatch(REASON); // this test home is not the person's own: nothing of launchd's is touched
      expect(Date.now() - t0).toBeLessThan(8000); // it did not wait for a daemon to come up
      expect(await tryConnect(e2.paths, 300)).toBeNull(); // and none was started for it
      expect(JSON.parse(fs.readFileSync(e2.paths.config, 'utf8')).session.keepRunning).toBe(true); // (refused: as the daemon's own service.remove)
      expect(fs.existsSync(path.join(e2.userHome, 'Library', 'LaunchAgents'))).toBe(false);
    } finally {
      const started = await tryConnect(e2.paths, 300);
      await started?.call('app.shutdown', {}).catch(() => undefined);
      started?.close();
      await sleep(300);
      e2.cleanup();
    }
  }, 60_000);
});
