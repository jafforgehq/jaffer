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

/** A daemon stand-in: records every request and answers it. */
async function fakeDaemon(): Promise<void> {
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
        sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server!.listen(env.paths.socket, () => r()));
}

/** Async on purpose: the stand-in daemon lives in this process and must be able to answer while the hook runs. */
function hook(arg: string, input: string, extra: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [cli, 'hook', arg], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: env.userHome, JAFFER_HOME: env.home, JAFFER_SESSION: '', JAFFER_NO_HOOKS: '', ...extra } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const guard = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('close', (status) => (clearTimeout(guard), resolve({ status, stdout, ms: Date.now() - t0 })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
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
    for (const arg of ['user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'subagent-start', 'subagent-stop', 'notification', 'session-end']) {
      const r = await hook(arg, PAYLOAD, { JAFFER_SESSION: '1' });
      expect(r, arg).toMatchObject({ status: 0, stdout: '' });
    }
    expect(received.filter((m) => m.method === 'claude.event')).toHaveLength(8);
    expect(received[0]!.params).toMatchObject({ session_id: 'sess-1', tool_name: 'Bash' });
  });

  it('outside a Jaffer session (a claude run in another terminal) it sends nothing', async () => {
    await fakeDaemon();
    expect(await hook('pre-tool-use', PAYLOAD)).toMatchObject({ status: 0, stdout: '' });
    expect(await hook('session-end', PAYLOAD)).toMatchObject({ status: 0, stdout: '' });
    expect(connections).toBe(0);
  });

  it('for Jaffer\'s own helper claude (JAFFER_NO_HOOKS) it sends nothing even inside a session', async () => {
    await fakeDaemon();
    expect(await hook('pre-tool-use', PAYLOAD, { JAFFER_SESSION: '1', JAFFER_NO_HOOKS: '1' })).toMatchObject({ status: 0, stdout: '' });
    expect(connections).toBe(0);
  });

  it('stop also reports (and keeps feeding memory): the payload reaches the daemon and nothing is printed', async () => {
    await fakeDaemon();
    const r = await hook('stop', JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop', last_assistant_message: 'done' }), { JAFFER_SESSION: '1' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(received.some((m) => m.method === 'claude.event' && m.params.hook_event_name === 'Stop')).toBe(true);
  });
});
