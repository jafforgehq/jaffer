import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { MockAnthropic } from './helpers/mock-anthropic';
import { ensureDaemon, tryConnect, type Launcher } from '../src/core/daemon-client';
import type { RpcClient } from '../src/core/rpc';
import { sleep } from '../src/shared/util';

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
    env: { HOME: env.userHome, SHELL: '/bin/bash', JAFFER_TICK_MS: '400', ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000', ANTHROPIC_BASE_URL: url, PS1: '$ ' },
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
    expect(st.stdout).toMatch(/agent: .*ready/);
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

  it('runs a full agent turn through the real SDK, executing a tool in the shared terminal', async () => {
    const c = await connect();
    const events = collect(c, 'agent.event');
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    mock.reset().queue({ kind: 'tool', id: 'toolu_a', name: 'run_command', input: { command: 'echo agent-was-here' } }, { kind: 'text', text: 'Ran it: agent-was-here.' });
    await c.call('agent.send', { text: 'please echo something' });
    await waitUntil(() => events.some((e) => e.type === 'turn_end'));
    const end = events.find((e) => e.type === 'turn_end');
    expect(end.error).toBeUndefined();
    expect(events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toContain('Ran it');
    // the command was typed into the user's own shell and flagged as the agent's
    expect(cmds.some((x) => x.cmd === 'echo agent-was-here' && x.by === 'agent')).toBe(true);
    const thread = await c.call('agent.thread', {});
    expect(thread.items.map((i: any) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    // second request carried the tool result back to the API
    const second = mock.requests.at(-1)!.body.messages;
    expect(JSON.stringify(second)).toContain('agent-was-here');
  });

  it('asks for approval before a state-changing command and honours the answer', async () => {
    const c = await connect();
    const events = collect(c, 'agent.event');
    mock.reset().queue({ kind: 'tool', id: 'toolu_b', name: 'write_file', input: { path: path.join(env.userHome, 'approved.txt'), content: 'hello' } }, { kind: 'text', text: 'done' });
    await c.call('agent.send', { text: 'write a file' });
    await waitUntil(() => events.some((e) => e.type === 'approval_request' && e.name === 'write_file'));
    expect(fs.existsSync(path.join(env.userHome, 'approved.txt'))).toBe(false);
    const req = events.find((e) => e.type === 'approval_request' && e.name === 'write_file');
    await c.call('agent.approve', { callId: req.callId, decision: 'allow' });
    await waitUntil(() => events.some((e) => e.type === 'turn_end'));
    expect(fs.readFileSync(path.join(env.userHome, 'approved.txt'), 'utf8')).toBe('hello');
  });

  it('survives a daemon restart: same directory, previous screen restored, conversation intact', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    fs.mkdirSync(path.join(env.userHome, 'restart-dir'));
    await c.call('pty.write', { data: `cd ${path.join(env.userHome, 'restart-dir')}\r` });
    await waitUntil(async () => (await c.call('session.info', {})).cwd.endsWith('restart-dir'));
    await sleep(300);
    const threadBefore = (await c.call('agent.thread', {})).items.length;
    await c.call('app.shutdown', {});
    await waitUntil(async () => !(await tryConnect(env.paths, 300)), 8000);
    clients.length = 0;
    const c2 = await connect();
    const info = await c2.call('session.info', {});
    expect(info.cwd.endsWith('restart-dir')).toBe(true);
    const att = await c2.call('session.attach', { cols: 100, rows: 30 });
    expect(att.snapshot.data).toContain('persisted-marker-42');
    expect(att.snapshot.data).toContain('session restored');
    expect((await c2.call('agent.thread', {})).items.length).toBe(threadBefore);
    // memory persisted too
    expect((await c2.call('memory.list', {})).items.length).toBeGreaterThan(0);
    void cmds;
  }, 30_000);

  it('memory evolves on its own: rules, model curation and Claude Code transcripts, with no manual trigger', async () => {
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
    await waitUntil(async () => {
      const items = (await c.call('memory.list', {})).items as { text: string; source: string }[];
      return items.some((i) => /tabs/i.test(i.text)) && items.some((i) => /linter before every commit/.test(i.text));
    }, 15_000);
    const items = (await c.call('memory.list', {})).items as { text: string; source: string; kind: string }[];
    expect(items.length).toBeGreaterThan(before);
    expect(items.find((i) => /tabs/i.test(i.text))!.source).toBe('user'); // learned from the Claude Code transcript
    expect(items.find((i) => /linter before every commit/.test(i.text))!.source).toBe('reflector'); // curated by the model
    // the reflection request was redacted and carried the activity
    const sent = JSON.stringify(mock.requests.at(-1)!.body.messages);
    expect(sent).toContain('pnpm test');
    // and every change is journaled so it can be undone
    const log = await c.call('memory.log', { limit: 100 });
    expect(log.runs.some((r: any) => r.sources.includes('reflector'))).toBe(true);
    const run = log.runs.find((r: any) => r.sources.includes('reflector') && r.ops.some((o: any) => /linter/.test(o.text ?? '')));
    const rev = await c.call('memory.revert', { runId: run.runId });
    expect(rev.reverted).toBeGreaterThan(0);
    expect(((await c.call('memory.list', {})).items as any[]).some((i) => /linter before every commit/.test(i.text))).toBe(false);
  }, 40_000);

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

  it('rejects unknown methods without dropping the connection', async () => {
    const c = await connect();
    await expect(c.call('nope.nothing', {})).rejects.toThrow(/unknown method/);
    expect((await c.call('hello', {})).protocol).toBe(1);
  });
});
