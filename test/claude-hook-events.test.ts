import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';

/**
 * `jaffer hook <event>` as Claude Code runs it: payload on stdin, must be silent and fast whatever happens, and
 * must report only from inside a Jaffer session. The real built CLI, against a stand-in daemon socket.
 */
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist/cli/jaffer.cjs');
const PAYLOAD = JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/work/app' });

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--only=cli'], { stdio: 'ignore' });
}, 60_000);

let env: TestEnv;
let server: net.Server | null = null;
let received: { method: string; params: any }[] = [];
let connections = 0;
beforeEach(() => {
  env = makeEnv();
  received = [];
  connections = 0;
});
afterEach(async () => {
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  server = null;
  env.cleanup();
});
afterAll(() => undefined);

/** A daemon stand-in: records every request and answers it (by default `{ ok: true }`). */
async function fakeDaemon(answer: (method: string) => unknown = () => ({ ok: true })): Promise<void> {
  fs.mkdirSync(path.dirname(env.paths.socket), { recursive: true });
  server = net.createServer((sock) => {
    connections++;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        received.push({ method: msg.method, params: msg.params });
        sock.write(JSON.stringify({ id: msg.id, result: answer(msg.method) }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server!.listen(env.paths.socket, () => r()));
}

/** Async on purpose: the stand-in daemon lives in this process and must be able to answer while the hook runs. (`keepOpen`: stdin is never closed.) */
function hook(arg: string, input: string, extra: NodeJS.ProcessEnv = {}, keepOpen = false): Promise<{ status: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [cli, 'hook', arg], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: env.userHome, JAFFER_HOME: env.home, JAFFER_SESSION: '', JAFFER_NO_HOOKS: '', ...extra } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const guard = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('close', (status) => (clearTimeout(guard), resolve({ status, stdout, ms: Date.now() - t0 })));
    child.stdin.on('error', () => undefined);
    if (keepOpen) child.stdin.write(input);
    else child.stdin.end(input);
  });
}

describe('jaffer hook <event>', () => {
  it('with no daemon it is silent, exits 0 and returns quickly (Claude Code is never held up)', async () => {
    const r = await hook('pre-tool-use', PAYLOAD, { JAFFER_SESSION: '1' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
  });

  it('with garbage on stdin it is still silent and exits 0', async () => {
    await fakeDaemon();
    for (const input of ['not json', '', '{"half":', '[]', 'null']) {
      const r = await hook('post-tool-use', input, { JAFFER_SESSION: '1' });
      expect(r, input).toMatchObject({ status: 0, stdout: '' });
    }
  });

  it('inside a Jaffer session it forwards the payload to the daemon as claude.event', async () => {
    await fakeDaemon();
    for (const arg of ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'subagent-start', 'subagent-stop', 'notification', 'stop', 'session-end']) {
      const r = await hook(arg, PAYLOAD, { JAFFER_SESSION: '1' });
      expect(r, arg).toMatchObject({ status: 0, stdout: '' });
    }
    expect(received.filter((m) => m.method === 'claude.event')).toHaveLength(10);
    expect(received.map((m) => m.method).filter((m) => m !== 'claude.event')).toEqual([]); // nothing else is asked
    expect(received[0]!.params).toMatchObject({ session_id: 'sess-1', tool_name: 'Bash' });
  });

  it('outside a Jaffer session (a claude run in another terminal) it sends nothing', async () => {
    await fakeDaemon();
    for (const arg of ['session-start', 'pre-tool-use', 'stop', 'session-end']) expect(await hook(arg, PAYLOAD), arg).toMatchObject({ status: 0, stdout: '' });
    expect(connections).toBe(0);
  });

  it('for Jaffer\'s own helper claude (JAFFER_NO_HOOKS) it sends nothing even inside a session', async () => {
    await fakeDaemon();
    expect(await hook('pre-tool-use', PAYLOAD, { JAFFER_SESSION: '1', JAFFER_NO_HOOKS: '1' })).toMatchObject({ status: 0, stdout: '' });
    expect(connections).toBe(0);
  });

  it('stop also reports: the payload reaches the daemon and nothing is printed', async () => {
    await fakeDaemon();
    const r = await hook('stop', JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop', last_assistant_message: 'done' }), { JAFFER_SESSION: '1' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(received.some((m) => m.method === 'claude.event' && m.params.hook_event_name === 'Stop')).toBe(true);
    expect(received.map((m) => m.method)).toEqual(['claude.event']);
  });

  // 1.2.0: the one hook whose output Claude Code reads (installed only with claude.approvals on)
  const REQUEST = JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  it('permission-request asks the daemon (claude.approval, not claude.event) and prints exactly the decision Claude Code reads', async () => {
    let decision: unknown = 'allow';
    await fakeDaemon((m) => (m === 'claude.approval' ? { decision } : { ok: true }));
    expect(await hook('permission-request', REQUEST, { JAFFER_SESSION: '1' })).toMatchObject({ status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' });
    decision = 'deny';
    expect(await hook('permission-request', REQUEST, { JAFFER_SESSION: '1' })).toMatchObject({ status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jaffer"}}}' });
    expect(received.map((m) => m.method)).toEqual(['claude.approval', 'claude.approval']);
    expect(received[0]!.params).toEqual({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  });

  it('permission-request prints nothing for any other answer: null, a bad decision, text, an error', async () => {
    const answers: unknown[] = [{ decision: null }, { decision: 'ALLOW' }, { decision: 'yes' }, { decision: ['allow'] }, 'allow', null, { ok: true }];
    for (const a of answers) {
      await fakeDaemon(() => a);
      const r = await hook('permission-request', REQUEST, { JAFFER_SESSION: '1' });
      expect(r, JSON.stringify(a)).toMatchObject({ status: 0, stdout: '' });
      await new Promise((r) => server!.close(() => r(null)));
      server = null;
    }
  });

  it('permission-request with no daemon, outside a session, for the helper claude, or with garbage or more than 1 MB on stdin: silent, exit 0, nothing asked', async () => {
    const down = await hook('permission-request', REQUEST, { JAFFER_SESSION: '1' });
    expect(down).toMatchObject({ status: 0, stdout: '' });
    expect(down.ms).toBeLessThan(3_000);
    await fakeDaemon(() => ({ decision: 'allow' }));
    expect(await hook('permission-request', REQUEST)).toMatchObject({ status: 0, stdout: '' });
    expect(await hook('permission-request', REQUEST, { JAFFER_SESSION: '1', JAFFER_NO_HOOKS: '1' })).toMatchObject({ status: 0, stdout: '' });
    for (const input of ['not json', '', '[]', 'null', JSON.stringify({ ...JSON.parse(REQUEST), tool_input: { command: 'x'.repeat(1024 * 1024 + 10) } })]) {
      expect(await hook('permission-request', input, { JAFFER_SESSION: '1' }), input.slice(0, 20)).toMatchObject({ status: 0, stdout: '' });
    }
    expect(received.filter((m) => m.method === 'claude.approval')).toEqual([]);
  });

  it('permission-request exits as soon as it has answered, also when Claude Code keeps its stdin open', async () => {
    await fakeDaemon((m) => (m === 'claude.approval' ? { decision: 'deny' } : { ok: true }));
    const r = await hook('permission-request', REQUEST, { JAFFER_SESSION: '1' }, true);
    expect(r).toMatchObject({ status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jaffer"}}}' });
    expect(r.ms).toBeLessThan(5_000);
  });

  it('session-start only reports too: whatever the daemon answers, nothing is printed for Claude Code to read', async () => {
    await fakeDaemon(() => 'something a daemon could say');
    const r = await hook('session-start', JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart', cwd: env.userHome, source: 'startup' }), { JAFFER_SESSION: '1' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(received.map((m) => m.method)).toEqual(['claude.event']);
    expect(received[0]!.params).toMatchObject({ hook_event_name: 'SessionStart' });
  });
});

describe('jaffer setup claude', () => {
  it('keeps the approvals hook while claude.approvals is on (it reads the config), and leaves it out while it is off', async () => {
    fs.mkdirSync(env.paths.binDir, { recursive: true });
    fs.writeFileSync(path.join(env.paths.binDir, 'jaffer'), '#!/bin/sh\n', { mode: 0o755 });
    const settings = path.join(env.userHome, '.claude', 'settings.json');
    const ours = () => ((JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.PermissionRequest ?? []) as any[]).filter((e) => e.hooks.some((h: any) => String(h.command).includes('# jaffer-managed')));
    const setup = () => execFileSync(process.execPath, [cli, 'setup', 'claude'], { env: { ...process.env, HOME: env.userHome, JAFFER_HOME: env.home, JAFFER_SESSION: '' }, timeout: 30_000 });
    env.config.patch({ claude: { approvals: true } });
    setup();
    expect(ours()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop).toBeDefined(); // (and the eleven)
    env.config.patch({ claude: { approvals: false } });
    setup();
    expect(ours()).toHaveLength(0);
  }, 40_000);
});
