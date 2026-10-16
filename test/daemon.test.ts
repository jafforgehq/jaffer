import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { fakeClaude } from './helpers/fake-claude';
import { MockAnthropic } from './helpers/mock-anthropic';
import { ensureDaemon, tryConnect, type Launcher } from '../src/core/daemon-client';
import type { RpcClient } from '../src/core/rpc';
import { sleep } from '../src/shared/util';
import { findClaude, installHooks } from '../src/core/integrations/claude';
import { STOP_AFTER_END_GRACE_MS } from '../src/core/claude/cost';
import { weekId } from '../src/shared/usage-week';
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
      // (a line start is a \r or a \n: bash on Linux answers Enter with \r only, before the command's output)
      const lineStart = (name: string) => new RegExp(`[\\r\\n]${name}`);
      await waitUntil(() => lineStart(`fresh-${marker}`).test(afterLastReset().text), 5_000);
      const end = afterLastReset();
      expect(end.inOrder).toBe(true);
      expect(end.text).not.toMatch(lineStart(marker));
    };
    await replaced(() => c.call('pty.write', { data: 'exit\r' }), 'replaced-by-exit-53');
    await replaced(() => c.call('session.restart', {}), 'replaced-by-restart-54');
    expect(heard).toEqual([]);
    bystander.close();
  }, 60_000);

  // Changed on purpose for 1.4.0 (the spec replaces the one-session rule): up to four terminals, only by a split.
  it('up to four terminals: pane.split opens one in the folder of the one it splits, a fifth is refused, pane.close ends one for good, never the last', async () => {
    const c = await connect();
    const life = collect(c, 'session.lifecycle');
    await c.call('session.attach', { cols: 100, rows: 30 });
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(env.root, 'split-')));
    const second = await c.call('pane.split', { cwd: folder, cols: 80, rows: 24 });
    expect(second).toMatchObject({ id: 'p2', cwd: folder, cols: 80, rows: 24, alive: true });
    expect((await c.call('pane.split', { pane: 'p2' })).cwd).toBe(folder); // (no folder given: the one of the terminal it splits)
    await c.call('pane.split', {});
    expect((await c.call('pane.list', {})).map((p: any) => p.id)).toEqual(['main', 'p2', 'p3', 'p4']);
    await expect(c.call('pane.split', {})).rejects.toThrow('At most four terminals.');
    await expect(c.call('pane.split', { pane: 'nope' })).rejects.toThrow(/No such pane/);
    for (const id of ['p4', 'p3']) expect(await c.call('pane.close', { pane: id })).toBe(true);
    await expect(c.call('pane.close', { pane: 'p3' })).rejects.toThrow(/No such pane/);
    await waitUntil(() => life.some((e) => e.pane === 'p3' && e.lifecycle === 'closed'));
    expect(life.filter((e) => e.lifecycle === 'spawned').map((e) => e.pane)).toEqual(['p2', 'p3', 'p4']);
    await sleep(500);
    expect((await c.call('pane.list', {})).map((p: any) => p.id)).toEqual(['main', 'p2']); // nothing comes back by itself
    expect(await c.call('pane.close', { pane: 'p2' })).toBe(true);
    await expect(c.call('pane.close', { pane: 'main' })).rejects.toThrow('Use restart for the last terminal.');
    expect((await c.call('pane.list', {})).map((p: any) => p.id)).toEqual(['main']);
  });

  it('each terminal streams on its own: events carry their pane, a window gets only the terminals it attached to, and detaching one keeps the others', async () => {
    const c = await connect();
    const log: { event: string; data: any }[] = [];
    c.on('*', (m) => log.push(m));
    await c.call('session.attach', { cols: 100, rows: 30 }); // (no pane: main, as before)
    await c.call('pane.split', {});
    await waitUntil(async () => (await c.call('pane.list', {}))[1]?.alive === true);
    const att = await c.call('session.attach', { pane: 'p2', cols: 90, rows: 25 });
    expect(att).toMatchObject({ pane: 'p2', snapshot: { cols: 90, rows: 25 } });
    expect(att.panes.map((p: any) => p.id)).toEqual(['main', 'p2']);
    const ran = (pane: string, cmd: string) => log.some((m) => m.event === 'pty.command' && m.data.pane === pane && m.data.cmd === cmd);
    const printed = (pane: string, text: string) => log.some((m) => m.event === 'pty.data' && m.data.pane === pane && m.data.data.includes(text));
    await sleep(800);
    await c.call('pty.write', { pane: 'p2', data: 'echo only-in-p2-61\r' });
    await c.call('pty.write', { data: 'echo only-in-main-62\r' });
    await waitUntil(() => ran('p2', 'echo only-in-p2-61') && ran('main', 'echo only-in-main-62'));
    expect(printed('main', 'only-in-p2-61') || printed('p2', 'only-in-main-62')).toBe(false);
    const snap = async (pane: string) => ((await c.call('session.snapshot', { pane })) as { data: string }).data;
    expect(await snap('p2')).toContain('only-in-p2-61');
    expect(await snap('p2')).not.toContain('only-in-main-62');
    // a second window attached to main only hears nothing of p2
    const other = await connect();
    const heard: { event: string; data: any }[] = [];
    other.on('*', (m) => heard.push(m));
    await other.call('session.attach', { pane: 'main' });
    // detached from p2, the first window still gets main
    expect(await c.call('session.detach', { pane: 'p2' })).toBe(true);
    const mark = log.length;
    await c.call('pty.write', { pane: 'p2', data: 'echo after-detach-63\r' });
    await c.call('pty.write', { pane: 'main', data: 'echo still-attached-64\r' });
    await waitUntil(() => ran('main', 'echo still-attached-64'));
    await waitUntil(async () => (await snap('p2')).includes('after-detach-63'));
    await sleep(300);
    expect(log.slice(mark).some((m) => m.data?.pane === 'p2')).toBe(false);
    expect(heard.some((m) => m.data?.pane === 'p2')).toBe(false);
    expect(heard.some((m) => m.event === 'pty.command' && m.data.cmd === 'echo still-attached-64')).toBe(true);
    // session.info and session.restart take a pane: restarting p2 leaves main's shell as it was
    expect((await c.call('session.info', { pane: 'p2' })).cwd).toBe(fs.realpathSync(env.userHome));
    await expect(c.call('session.info', { pane: 'nope' })).rejects.toThrow(/No such pane/);
    const [main, p2] = await c.call('pane.list', {});
    await c.call('session.restart', { pane: 'p2' });
    await waitUntil(async () => {
      const p = (await c.call('pane.list', {}))[1];
      return p.alive && p.pid !== p2.pid;
    });
    expect((await c.call('pane.list', {}))[0].pid).toBe(main.pid);
    // closing p2: told to every window, and it is gone
    expect(await c.call('pane.close', { pane: 'p2' })).toBe(true);
    await waitUntil(() => heard.some((m) => m.event === 'session.lifecycle' && m.data.pane === 'p2' && m.data.lifecycle === 'closed'));
    expect((await c.call('pane.list', {}))[0].pid).toBe(main.pid);
    other.close();
  }, 40_000);

  it('pane.split takes only a folder: a file or a missing path splits in the folder of the terminal it splits', async () => {
    const c = await connect();
    await c.call('session.attach', { cols: 100, rows: 30 });
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(env.root, 'split-from-')));
    const file = path.join(folder, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    await c.call('pty.write', { data: `cd '${folder}'\r` });
    await waitUntil(async () => (await c.call('session.info', {})).cwd === folder);
    for (const cwd of [file, path.join(folder, 'missing')]) {
      const p = await c.call('pane.split', { cwd });
      expect(p.cwd, cwd).toBe(folder);
      await waitUntil(async () => (await c.call('pane.list', {}))[1]?.alive === true);
      expect(await c.call('pane.close', { pane: p.id })).toBe(true);
    }
    await c.call('pty.write', { data: 'cd\r' });
  });

  it('falling behind is per terminal: a window too slow for one gets that one back from a snapshot (not the others), and none for a terminal it let go of meanwhile', async () => {
    const c = await connect();
    const done = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await c.call('pane.split', {});
    await c.call('session.attach', { pane: 'p2' });
    await waitUntil(async () => (await c.call('pane.list', {}))[1]?.alive === true);
    await sleep(800);
    // a window that stops reading its socket (a raw connection, so that it really falls behind)
    const sock = net.createConnection(env.paths.socket);
    await new Promise((r) => sock.once('connect', r));
    const got: any[] = [];
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        got.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    let id = 0;
    const send = (method: string, params: object) => (sock.write(JSON.stringify({ id: ++id, method, params }) + '\n'), id);
    const answered = (n: number) => got.some((m) => m.id === n);
    const resets = (pane: string, from = 0) => got.slice(from).filter((m) => m.event === 'pty.reset' && m.data.pane === pane);
    const flood = async (n: number) => {
      const cmd = `yes flood-${n}-abcdefghijklmnopqrstuvwxyz0123456789 | head -c 16000000`;
      await c.call('pty.write', { pane: 'p2', data: `${cmd}\r` });
      await waitUntil(() => done.some((x) => x.pane === 'p2' && x.cmd === cmd), 30_000);
    };
    const a = send('session.attach', { pane: 'main' });
    const b = send('session.attach', { pane: 'p2' });
    await waitUntil(() => answered(a) && answered(b));
    // still attached to p2 when it catches up: p2 comes back from a snapshot, main never fell behind and keeps streaming
    sock.pause();
    await flood(1);
    sock.resume();
    await waitUntil(() => resets('p2').length === 1, 20_000);
    expect(resets('main')).toEqual([]);
    await c.call('pty.write', { data: 'echo main-still-streams-71\r' });
    await waitUntil(() => got.some((m) => m.event === 'pty.data' && m.data.pane === 'main' && m.data.data.includes('main-still-streams-71')), 10_000);
    // let go of p2 while behind on it: no snapshot of p2 follows
    sock.pause();
    await flood(2);
    const d = send('session.detach', { pane: 'p2' });
    sock.resume();
    await waitUntil(() => answered(d), 20_000);
    const after = got.findIndex((m) => m.id === d);
    const h = send('hello', {});
    await waitUntil(() => answered(h), 10_000);
    await sleep(1500);
    expect(resets('p2', after)).toEqual([]);
    sock.destroy();
    expect(await c.call('pane.close', { pane: 'p2' })).toBe(true);
  }, 90_000);

  it('a Claude in one terminal is that terminal\'s: its hooks say which (JAFFER_PANE), and the other terminal ending (exit, close, its claude command) leaves it working', async () => {
    const c = await connect();
    const cmds = collect(c, 'pty.command');
    await c.call('session.attach', { cols: 100, rows: 30 });
    await c.call('pane.split', {});
    await c.call('session.attach', { pane: 'p2' });
    await waitUntil(async () => (await c.call('pane.list', {}))[1]?.alive === true);
    await sleep(800);
    const sessions = async () => (await c.call('claude.state', {})).sessions as ClaudeSession[];
    const stateOf = async (id: string) => (await sessions()).find((s) => s.id === id)?.state;
    // the real hook, from inside p2's shell: the CLI adds the terminal's id
    const P2 = 'c1a0de00-0000-4000-8000-000000000022';
    await c.call('pty.write', { pane: 'p2', data: `echo '{"session_id":"${P2}","hook_event_name":"UserPromptSubmit","prompt":"go"}' | jaffer hook user-prompt-submit\r` });
    await waitUntil(async () => (await stateOf(P2)) === 'working');
    expect((await sessions()).find((s) => s.id === P2)!.pane).toBe('p2');
    const MAIN = 'c1a0de00-0000-4000-8000-000000000011';
    await c.call('claude.event', { session_id: MAIN, hook_event_name: 'UserPromptSubmit', prompt: 'go', jaffer_pane: 'main' });
    // main's claude command ends (the stand-in exits): main's Claude is over, p2's goes on
    await c.call('pty.write', { data: 'claude\r' });
    await waitUntil(() => cmds.some((x) => x.pane === 'main' && x.cmd === 'claude'));
    await waitUntil(async () => (await stateOf(MAIN)) === 'ended');
    expect(await stateOf(P2)).toBe('working');
    // main's shell exits (and comes back): p2's Claude still goes on
    await c.call('claude.event', { session_id: MAIN, hook_event_name: 'SessionStart', source: 'resume', jaffer_pane: 'main' });
    await c.call('claude.event', { session_id: MAIN, hook_event_name: 'UserPromptSubmit', prompt: 'go', jaffer_pane: 'main' });
    await c.call('pty.write', { data: 'exit\r' });
    await waitUntil(async () => (await stateOf(MAIN)) === 'ended');
    expect(await stateOf(P2)).toBe('working');
    // typing in main answers only main's Claude: p2's waits on
    await c.call('claude.event', { session_id: P2, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_p2', jaffer_pane: 'p2' });
    await c.call('claude.event', { session_id: P2, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', jaffer_pane: 'p2' });
    await waitUntil(async () => (await stateOf(P2)) === 'needs-you');
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await c.call('pty.write', { data: 'x' });
    await sleep(300);
    expect(await stateOf(P2)).toBe('needs-you');
    await c.call('pty.write', { data: '\x15' });
    await c.call('pty.write', { pane: 'p2', data: 'y' });
    await waitUntil(async () => (await stateOf(P2)) === 'working');
    await c.call('pty.write', { pane: 'p2', data: '\x15' });
    // p2 is closed: its Claude went with it
    await c.call('pane.close', { pane: 'p2' });
    await waitUntil(async () => (await stateOf(P2)) === 'ended');
  }, 40_000);

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
    // it works again (the same conversation, so a resume), and the shell is restarted: the shell takes its Claude with it
    await hook('SessionStart', { source: 'resume' });
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

  it('after each prompt, says what changed in the folder\'s repository (git status, counted), and nothing outside one', async () => {
    const c = await connect();
    const repo = path.join(env.root, 'git-repo');
    fs.mkdirSync(repo);
    // real git, in a temporary repository only (and none of the person's own git settings)
    const gitEnv = { ...process.env, HOME: env.userHome, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'one\n');
    git('add', 'kept.txt');
    git('commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
    git('add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    const info = async () => c.call('session.info', {});
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
    await c.call('pty.write', { data: `cd '${repo}'\r` });
    await waitUntil(async () => (await info()).git !== undefined, 8000);
    expect(await info()).toMatchObject({ project: repo, git: { staged: 1, changed: 1, untracked: 1, ahead: 0, behind: 0 } });
    // the next prompt sees what changed since
    git('add', 'kept.txt');
    await c.call('pty.write', { data: 'true\r' });
    await waitUntil(async () => (await info()).git?.staged === 2, 8000);
    expect((await info()).git).toEqual({ staged: 2, changed: 0, untracked: 1, ahead: 0, behind: 0 });
    // outside a repository there is nothing to say
    await c.call('pty.write', { data: 'cd /\r' });
    await waitUntil(async () => (await info()).cwd === '/', 8000);
    await sleep(800);
    expect((await info()).git).toBeUndefined();
  });

  it('lists past Claude conversations from Claude Code\'s transcripts (newest first, the cost only with showCost) and keeps nothing of what was said but a title', async () => {
    const c = await connect();
    const dir = path.join(env.userHome, '.claude', 'projects', '-history-test'); // the daemon's CLAUDE_CONFIG_DIR
    fs.mkdirSync(dir, { recursive: true });
    const ids = ['a0000000-1111-4222-8333-444455556666', 'b0000000-1111-4222-8333-444455556666'];
    ids.forEach((id, i) => {
      const at = Date.parse('2026-10-01T10:00:00Z') + i * 3_600_000;
      const lines = [
        { type: 'user', cwd: '/history/folder', timestamp: new Date(at).toISOString(), message: { role: 'user', content: `Question ${i}` } },
        { type: 'user', cwd: '/history/folder', timestamp: new Date(at + 1000).toISOString(), message: { role: 'user', content: 'SECRET-PROMPT' } },
        { type: 'assistant', cwd: '/history/folder', timestamp: new Date(at + 30_000).toISOString(), message: { id: `m${i}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET-REPLY' }], usage: { input_tokens: 1000, output_tokens: 1000 } } },
      ];
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      fs.utimesSync(file, at / 1000 + 60, at / 1000 + 60);
    });
    const mine = (r: { items: any[] }) => r.items.filter((x) => ids.includes(x.id));
    const priced = await c.call('claude.history', {});
    expect(JSON.stringify(priced)).not.toContain('SECRET');
    expect(mine(priced)).toEqual([
      { id: ids[1], cwd: '/history/folder', startedAt: Date.parse('2026-10-01T11:00:00Z'), endedAt: Date.parse('2026-10-01T11:00:30Z'), durMs: 30_000, usd: (1000 * 2 + 1000 * 10) / 1e6, title: 'Question 1' },
      { id: ids[0], cwd: '/history/folder', startedAt: Date.parse('2026-10-01T10:00:00Z'), endedAt: Date.parse('2026-10-01T10:00:30Z'), durMs: 30_000, usd: (1000 * 2 + 1000 * 10) / 1e6, title: 'Question 0' },
    ]);
    await c.call('config.patch', { claude: { showCost: false } });
    try {
      expect(mine(await c.call('claude.history', {})).some((x) => 'usd' in x)).toBe(false);
    } finally {
      await c.call('config.patch', { claude: { showCost: true } });
    }
  });

  it('claude.usage5h (1.4.0): the tokens and estimated dollars of the last 5 hours across the transcripts, numbers only; links, subfolders and older lines left out', async () => {
    const c = await connect();
    const dir = path.join(env.userHome, '.claude', 'projects', '-usage-5h');
    fs.mkdirSync(path.join(dir, 'f0000000-1111-4222-8333-444455556666', 'subagents'), { recursive: true });
    const line = (id: string, ago: number, output: number) => `${JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - ago).toISOString(), message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET-REPLY' }], usage: { input_tokens: 0, output_tokens: output } } })}\n`;
    const before = await c.call('claude.usage5h', {});
    fs.writeFileSync(path.join(dir, 'e0000000-1111-4222-8333-444455556666.jsonl'), line('u1', 3_600_000, 100_000) + line('u0', 6 * 3_600_000, 9_000_000));
    fs.writeFileSync(path.join(dir, 'f0000000-1111-4222-8333-444455556666', 'subagents', 'agent-1.jsonl'), line('u2', 60_000, 9_000_000));
    fs.writeFileSync(path.join(env.root, 'elsewhere.jsonl'), line('u3', 60_000, 9_000_000));
    fs.symlinkSync(path.join(env.root, 'elsewhere.jsonl'), path.join(dir, 'd0000000-1111-4222-8333-444455556666.jsonl'));
    const r = await c.call('claude.usage5h', {});
    expect(r.tokens - before.tokens).toBe(100_000);
    expect(r.usd - (before.usd ?? 0)).toBeCloseTo(1, 9);
    expect(Object.keys(r).sort()).toEqual(['files', 'tokens', 'usd']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claude.usage5h with the cost switched off (1.4.0): an empty answer, no transcript read', async () => {
    const c = await connect();
    const dir = path.join(env.userHome, '.claude', 'projects', '-usage-5h-off');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'e1000000-1111-4222-8333-444455556666.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'z1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 0, output_tokens: 777 } } })}\n`);
    await c.call('config.patch', { claude: { showCost: false } });
    try {
      expect(await c.call('claude.usage5h', {})).toEqual({ tokens: 0, files: 0 });
    } finally {
      await c.call('config.patch', { claude: { showCost: true } });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claude.history takes include (1.2.0, the pinned ones): a conversation older than the 50 newest is listed too, with its title and no cost; bad ids are ignored', async () => {
    const c = await connect();
    const dir = path.join(env.userHome, '.claude', 'projects', '-history-include');
    fs.mkdirSync(dir, { recursive: true });
    const id = (n: number) => `${String(n).padStart(8, '0')}-cccc-4ddd-8eee-ffff00001111`;
    const plant = (n: number, at: number) => {
      const lines = [
        { type: 'user', cwd: '/include/folder', timestamp: new Date(at).toISOString(), message: { role: 'user', content: `Pinned question ${n}` } },
        { type: 'assistant', cwd: '/include/folder', timestamp: new Date(at + 1000).toISOString(), message: { id: `i${n}`, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET-REPLY' }], usage: { input_tokens: 1000, output_tokens: 1000 } } },
      ];
      const file = path.join(dir, `${id(n)}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      fs.utimesSync(file, at / 1000, at / 1000);
    };
    plant(0, Date.parse('2020-01-01T10:00:00Z')); // older than everything else
    for (let n = 1; n <= 50; n++) plant(n, Date.now() - n * 1000);
    const plain = (await c.call('claude.history', {})).items as { id: string }[];
    expect(plain).toHaveLength(50);
    expect(plain.some((x) => x.id === id(0))).toBe(false);
    const withPinned = (await c.call('claude.history', { include: ['x; rm -rf ~', id(0), 7, id(1)] })).items as { id: string }[];
    expect(withPinned).toHaveLength(51);
    expect(withPinned.at(-1)).toEqual({ id: id(0), cwd: '/include/folder', startedAt: Date.parse('2020-01-01T10:00:00Z'), endedAt: Date.parse('2020-01-01T10:00:01Z'), durMs: 1000, title: 'Pinned question 0' });
    expect(JSON.stringify(withPinned)).not.toContain('SECRET');
    expect(((await c.call('claude.history', { include: 'nope' })).items as unknown[]).length).toBe(50);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claude.storage, claude.old and claude.search (1.4.0): sizes, the oldest ids and the ids that match, nothing else; old takes 30, 60 or 90 days; search only with permissions.deepSearch', async () => {
    const c = await connect();
    const dir = path.join(env.userHome, '.claude', 'projects', '-p15-extras');
    fs.mkdirSync(dir, { recursive: true });
    const id = (n: number) => `${String(n).padStart(8, '0')}-abab-4ddd-8eee-ffff00001111`;
    const plant = (n: number, daysAgo: number, words: string) => {
      const at = Date.now() - daysAgo * 86_400_000;
      const file = path.join(dir, `${id(n)}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/p15/folder', timestamp: new Date(at).toISOString(), message: { role: 'user', content: words } }) + '\n' + 'x'.repeat(n === 2 ? 900_000 : 10));
      fs.utimesSync(file, at / 1000, at / 1000);
    };
    plant(1, 100, 'p15-word once');
    plant(2, 45, 'nothing to see');
    plant(3, 0, 'P15-WORD and p15-word');
    fs.mkdirSync(path.join(dir, id(2)));
    fs.writeFileSync(path.join(dir, id(2), 'tool-result.txt'), 'y'.repeat(100_000));

    const s = await c.call('claude.storage', {});
    expect(Object.keys(s).sort()).toEqual(['biggest', 'count', 'totalBytes']);
    expect(s.count).toBeGreaterThanOrEqual(3);
    const big = s.biggest.find((b: { id: string }) => b.id === id(2));
    expect(big).toMatchObject({ id: id(2), cwd: '/p15/folder' });
    expect(big.bytes).toBe(fs.statSync(path.join(dir, `${id(2)}.jsonl`)).size + 100_000);

    const o30 = await c.call('claude.old', { days: 30 });
    expect(o30.ids.filter((x: string) => x.endsWith('-abab-4ddd-8eee-ffff00001111'))).toEqual([id(1), id(2)]);
    expect(o30.total).toBe(o30.ids.length);
    expect(o30.counts[30]).toBe(o30.total);
    expect(o30.counts[90]).toBe((await c.call('claude.old', { days: 90 })).total);
    expect((await c.call('claude.old', { days: 90 })).ids.filter((x: string) => x.endsWith('-abab-4ddd-8eee-ffff00001111'))).toEqual([id(1)]);
    for (const days of [7, '30', null, 365]) await expect(c.call('claude.old', { days }), String(days)).rejects.toThrow(/30, 60 or 90/);

    expect((await c.call('config.get')).permissions.deepSearch).toBe(false);
    await expect(c.call('claude.search', { q: 'p15-word' })).rejects.toThrow(/off in Settings/);
    await c.call('config.patch', { permissions: { deepSearch: true } });
    try {
      const r = await c.call('claude.search', { q: 'p15-word' });
      expect(r).toEqual({ hits: [{ id: id(3), count: 2 }, { id: id(1), count: 1 }], partial: false });
      await expect(c.call('claude.search', { q: 'ab' })).rejects.toThrow(/3 to 64/);
      await expect(c.call('claude.search', {})).rejects.toThrow(/3 to 64/);
    } finally {
      await c.call('config.patch', { permissions: { deepSearch: false } });
    }
    await expect(c.call('claude.search', { q: 'p15-word' })).rejects.toThrow(/off in Settings/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claude.setup (1.4.0): the Setup list of a folder from Claude Code\'s files (never ~/.claude.json, never a hook command); a folder that is not absolute or not there means the home folder', async () => {
    const c = await connect();
    const claudeDir = path.join(env.userHome, '.claude'); // the daemon's CLAUDE_CONFIG_DIR
    const proj = path.join(env.userHome, 'setup-proj');
    const put = (p: string, t: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t));
    put(path.join(claudeDir, 'skills/s-user/SKILL.md'), '---\nname: s-user\ndescription: a user skill\n---\n');
    put(path.join(proj, '.claude/skills/s-proj/SKILL.md'), '---\nname: s-proj\n---\n');
    put(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'srv-a': { command: 'npx', args: ['SECRET-ARG'] } } }));
    put(path.join(proj, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo SECRET-HOOK' }] }] } }));
    put(path.join(env.userHome, '.claude.json'), '{"oauthAccount":"SECRET-LOGIN"}');
    try {
      const s = await c.call('claude.setup', { cwd: proj });
      expect(s.skills.map((k: { name: string; scope: string }) => `${k.scope}:${k.name}`)).toEqual(['user:s-user', 'project:s-proj']);
      expect(s.mcpFile).toEqual([{ name: 'srv-a', scope: 'project' }]);
      expect(s.hooks).toContainEqual({ event: 'PostToolUse', count: 1 });
      expect(JSON.stringify(s)).not.toMatch(/SECRET|npx/);
      for (const cwd of ['setup-proj', path.join(proj, 'nope'), `${proj}\n`, 'x'.repeat(5000), 5, null]) {
        const h = await c.call('claude.setup', { cwd });
        expect(h.mcpFile, String(cwd)).toEqual([]);
        expect(h.skills.map((k: { name: string }) => k.name), String(cwd)).toEqual(['s-user']);
      }
      expect((await c.call('claude.setup', {})).skills.map((k: { name: string }) => k.name)).toEqual(['s-user']);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
      fs.rmSync(path.join(claudeDir, 'skills'), { recursive: true, force: true });
      fs.rmSync(path.join(env.userHome, '.claude.json'), { force: true });
    }
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

  it('claude.mcp (1.4.0): `claude mcp list` in the asked folder (else the home folder), parsed to names and states; one at a time: a second ask while one runs gets the same answer', async () => {
    fake.setMode('ok');
    fake.setMcpList('Checking MCP server health…\n\ngh: npx -y server --token SECRET-TOKEN - ✓ Connected\nlin: https://example.com/SECRET (HTTP) - ⚠ Needs authentication\n');
    const proj = path.join(env2.userHome, 'mcp-proj');
    fs.mkdirSync(proj, { recursive: true });
    const r = await c.call('claude.mcp', { cwd: proj });
    expect(r).toEqual({ ok: true, servers: [{ name: 'gh', status: 'connected', label: 'Connected' }, { name: 'lin', status: 'needs-auth', label: 'Needs sign-in' }] });
    expect(fake.read('mcp.cwd')).toBe(fs.realpathSync(proj));
    expect(JSON.stringify(r)).not.toContain('SECRET');
    await c.call('claude.mcp', { cwd: 'relative/dir' });
    expect(fake.read('mcp.cwd')).toBe(fs.realpathSync(env2.userHome));
    fake.setMode('mcp-slow');
    const before = fake.calls().filter((l) => l.startsWith('mcp list')).length;
    const [a, b] = await Promise.all([c.call('claude.mcp', { cwd: proj }), c.call('claude.mcp', { cwd: env2.userHome })]);
    expect(a).toEqual(b);
    expect(fake.calls().filter((l) => l.startsWith('mcp list')).length).toBe(before + 1);
    fake.setMode('ok');
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
    for (const e of ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'SessionEnd', 'PreCompact']) {
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

  it('claude.hooks says when each of the eleven hook events was last heard since the daemon started, and PreCompact marks the session compacting', async () => {
    const before = Date.now();
    await hookCli('pre-compact', ev('PreCompact', { trigger: 'manual', custom_instructions: '' }));
    const { events } = await c.call('claude.hooks', {});
    expect(Object.keys(events).sort()).toEqual(['Notification', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
    expect(events.PreCompact).toBeGreaterThanOrEqual(before);
    expect(events.Stop).toBeLessThan(before); // heard in the test before this one
    expect(events.UserPromptSubmit).toBeLessThan(before);
    expect(events.PostToolUseFailure).toBeNull(); // nothing sent it yet
    expect((await states()).find((s) => s.id === 'sess-1')).toMatchObject({ compacting: true });
    await c.call('claude.event', ev('SessionStart', { source: 'compact' }));
    expect((await states()).find((s) => s.id === 'sess-1')?.compacting).toBeUndefined();
    expect((await c.call('claude.hooks', {})).events.SessionStart).toBeGreaterThanOrEqual(before);
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

  it('while Claude works, says what the answer has cost so far (read every 2 s from where the prompt began), pauses while it waits for the person, and Stop clears it', async () => {
    const transcript = path.join(env3.root, 'sess-live.jsonl');
    const reply = (id: string, output: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET words' }], usage: { input_tokens: 100, output_tokens: output } } })}\n`;
    fs.writeFileSync(transcript, reply('before', 1_000_000)); // an earlier answer in the same file is not this one
    const base = { session_id: 'sess-live', transcript_path: transcript };
    const live = async () => (await states()).find((s) => s.id === 'sess-live')?.live;
    const pushed = collect(c, 'claude.state');
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'go' }));
    fs.appendFileSync(transcript, reply('m1', 1000));
    await waitUntil(async () => (await live())?.output === 1000, 5_000);
    expect(await live()).toMatchObject({ input: 100, output: 1000 });
    expect((await live())!.usd).toBeCloseTo((100 * 2 + 1000 * 10) / 1e6, 9);
    fs.appendFileSync(transcript, reply('m2', 500)); // the transcript grows mid-turn
    await waitUntil(async () => (await live())?.output === 1500, 5_000);
    // waiting for the person: nothing is read meanwhile, the last figure stays
    await c.call('claude.event', ev('PreToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_l1' }));
    await c.call('claude.event', ev('Notification', { ...base, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    fs.appendFileSync(transcript, reply('m3', 500));
    await sleep(2_500);
    expect((await live())!.output).toBe(1500);
    await c.call('claude.event', ev('PostToolUse', { ...base, tool_name: 'Bash', tool_use_id: 'toolu_l1' }));
    await waitUntil(async () => (await live())?.output === 2000, 5_000);
    // at most one change of the figure every 2 s, and numbers only
    const ats = [...new Set(pushed.map((p) => p.sessions.find((s: ClaudeSession) => s.id === 'sess-live')?.live?.at).filter(Boolean))] as number[];
    expect(ats.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ats.length; i++) expect(ats[i]! - ats[i - 1]!).toBeGreaterThanOrEqual(1_900);
    expect(JSON.stringify(pushed)).not.toContain('SECRET');
    await c.call('claude.event', ev('Stop', base));
    expect(await live()).toBeUndefined();
    // the turn finished on its own and took longer than 3 s: it counts for the typical turn
    await waitUntil(async () => (await c.call('config.get', {})).claude.typicalTurnMs >= 3_000, 5_000);
    // and what the whole answer cost comes as after every answer
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-live')?.cost?.last.output === 2000, 5_000);
  }, 30_000);

  it('adds every finished answer to today\'s total once (a Stop heard twice is one answer), on the claude.state payload beside the sessions', async (ctx) => {
    // the daemon's day is the local date: a run across local midnight would see two days (the clock is the daemon's own, a process of its own)
    const now = new Date();
    if (new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() < 60_000) return ctx.skip();
    const transcript = path.join(env3.root, 'sess-today.jsonl');
    const reply = (id: string) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 0, output_tokens: 10_000 } } })}\n`;
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-today', transcript_path: transcript };
    const before = (await c.call('claude.state', {})).today;
    expect(before.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'once' }));
    fs.appendFileSync(transcript, reply('t1'));
    const pushed = collect(c, 'claude.state');
    await c.call('claude.event', ev('Stop', base));
    await c.call('claude.event', ev('Stop', base));
    await sleep(2_500); // past the read (300 ms) and its one retry (1.5 s later)
    expect((await states()).find((s) => s.id === 'sess-today')?.cost?.answers).toBe(1);
    const after = (await c.call('claude.state', {})).today;
    expect(after.date).toBe(before.date);
    expect(after.usd - before.usd).toBeCloseTo(0.1, 9); // 10 000 output tokens at $10 a million, once
    expect(pushed[pushed.length - 1].today).toEqual(after);
  });

  it('adds the time of every finished turn to today\'s worked time (turns under a second left out), with or without the cost switch', async (ctx) => {
    const now = new Date();
    if (new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() < 60_000) return ctx.skip();
    const base = { session_id: 'sess-work' };
    const worked = async () => (await c.call('claude.state', {})).today.workMs ?? 0;
    const w0 = await worked();
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'one' }));
    await sleep(1_200);
    await c.call('claude.event', ev('Stop', base));
    await c.call('claude.event', ev('Stop', base)); // heard twice: one turn
    const w1 = await worked();
    expect(w1 - w0).toBeGreaterThanOrEqual(1_150);
    expect(w1 - w0).toBeLessThan(5_000);
    await c.call('config.patch', { claude: { showCost: false } });
    try {
      await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'two' }));
      await sleep(1_200);
      await c.call('claude.event', ev('Stop', base));
    } finally {
      await c.call('config.patch', { claude: { showCost: true } });
    }
    const w2 = await worked();
    expect(w2 - w1).toBeGreaterThanOrEqual(1_150);
    expect(w2 - w1).toBeLessThan(5_000);
    // a turn under a second: not counted
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'quick' }));
    await sleep(200);
    await c.call('claude.event', ev('Stop', base));
    expect(await worked()).toBe(w2);
    await c.call('claude.event', ev('SessionEnd', base));
  }, 20_000);

  it('the context meter (1.4.0): after an answer, the tokens the latest response read in and its model\'s window; with the cost switched off nothing is read; numbers only', async () => {
    const transcript = path.join(env3.root, 'sess-ctx.jsonl');
    const reply = (id: string, model: string, usage: object) => `${JSON.stringify({ type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'SECRET words' }], usage } })}\n`;
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-ctx', transcript_path: transcript };
    const ctx = async () => (await states()).find((s) => s.id === 'sess-ctx')?.context;
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'go' }));
    fs.appendFileSync(transcript, reply('x1', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 99_999, cache_read_input_tokens: 600_000 }) + reply('x2', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 620_000, cache_creation_input_tokens: 1000 }));
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await ctx())?.tokens === 621_003, 5_000);
    expect(await ctx()).toEqual({ tokens: 621_003, window: 1_000_000, at: expect.any(Number) });
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'again' }));
    fs.appendFileSync(transcript, reply('x3', 'claude-haiku-4-5', { input_tokens: 40_000, output_tokens: 1 }));
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await ctx())?.tokens === 40_000, 5_000);
    expect((await ctx())!.window).toBe(200_000);
    // the cost switched off: the transcript is not read for anything, so another session gets no context at all
    const quiet = path.join(env3.root, 'sess-ctx-off.jsonl');
    fs.writeFileSync(quiet, '');
    await c.call('config.patch', { claude: { showCost: false } });
    try {
      await c.call('claude.event', ev('UserPromptSubmit', { session_id: 'sess-ctx-off', transcript_path: quiet, prompt: 'quiet' }));
      fs.appendFileSync(quiet, reply('q1', 'claude-opus-5-5', { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 50_000 }));
      await c.call('claude.event', ev('Stop', { session_id: 'sess-ctx-off', transcript_path: quiet }));
      await sleep(2_500); // past the read (300 ms) and its one retry
      const off = (await states()).find((s) => s.id === 'sess-ctx-off');
      expect(off).toBeDefined();
      expect(off!.context).toBeUndefined();
      expect(off!.cost).toBeUndefined();
    } finally {
      await c.call('config.patch', { claude: { showCost: true } });
    }
    await c.call('claude.event', ev('SessionEnd', { session_id: 'sess-ctx-off' }));
    expect(JSON.stringify(await states())).not.toContain('SECRET');
    await c.call('claude.event', ev('SessionEnd', base));
  });

  it('the week (1.4.0): every counted answer adds its cost and every finished turn its time to usage.week (config.json: numbers and the week id only)', async (ctx) => {
    const now = new Date();
    if (weekId(now.getTime() + 60_000) !== weekId(now.getTime())) return ctx.skip(); // (a run across the start of a week)
    const transcript = path.join(env3.root, 'sess-week.jsonl');
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-week', transcript_path: transcript };
    const week = async () => (await c.call('config.get', {})).usage.week as { id: string; usd: number; workMs: number };
    const w0 = await week();
    await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'go' }));
    await sleep(1_100);
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'w1', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 0, output_tokens: 10_000 } } })}\n`);
    await c.call('claude.event', ev('Stop', base));
    await waitUntil(async () => (await week()).usd - (w0.id === weekId(Date.now()) ? w0.usd : 0) > 0.0999, 5_000);
    const w1 = await week();
    expect(w1.id).toBe(weekId(Date.now()));
    expect(w1.workMs - (w0.id === w1.id ? w0.workMs : 0)).toBeGreaterThanOrEqual(1_000);
    const disk = JSON.parse(fs.readFileSync(env3.paths.config, 'utf8')).usage;
    expect(disk.week).toEqual(w1);
    await c.call('claude.event', ev('SessionEnd', base));
  });

  it('the live figure follows the switches: nothing is read with the cost or its live part off', async () => {
    const transcript = path.join(env3.root, 'sess-nolive.jsonl');
    const reply = (id: string) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 10 } } })}\n`;
    fs.writeFileSync(transcript, '');
    const base = { session_id: 'sess-nolive', transcript_path: transcript };
    const live = async () => (await states()).find((s) => s.id === 'sess-nolive')?.live;
    for (const off of [{ liveCost: false }, { showCost: false }]) {
      await c.call('config.patch', { claude: off });
      await c.call('claude.event', ev('UserPromptSubmit', { ...base, prompt: 'quiet' }));
      fs.appendFileSync(transcript, reply(`n${JSON.stringify(off)}`));
      await sleep(2_500);
      expect(await live(), JSON.stringify(off)).toBeUndefined();
      await c.call('claude.event', ev('Stop', base));
      await c.call('config.patch', { claude: { liveCost: true, showCost: true } });
    }
  }, 20_000);

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

  it('a Claude resumed from the side panel (`cd \'<folder>\' && claude --resume <id>`, a space and a quote in the folder) ends every session when it ends', async () => {
    await c.call('claude.event', ev('UserPromptSubmit', { session_id: 'sess-cd', prompt: 'resumed' }));
    expect((await states()).find((s) => s.id === 'sess-cd')?.state).toBe('working');
    const odd = path.join(env3.userHome, "it's odd");
    fs.mkdirSync(odd, { recursive: true });
    await c.call('pty.write', { data: 'claude() { :; }\r' });
    await sleep(300);
    await c.call('pty.write', { data: `cd '${odd.replace(/'/g, `'\\''`)}' && claude --resume 01234567-89ab-4cde-8f01-23456789abcd\r` });
    await waitUntil(async () => (await states()).find((s) => s.id === 'sess-cd')?.state === 'ended', 8_000);
    await c.call('pty.write', { data: 'cd ~\r' });
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

describe('answering a permission prompt from the notification (1.2.0, claude.approvals; bundled daemon and the real jaffer CLI)', () => {
  let env5: TestEnv;
  let app: RpcClient;
  const WAIT = 2_000; // JAFFER_TEST_APPROVAL_WAIT_MS: the 20 s wait, short for the tests
  const settings = () => path.join(env5.userHome, '.claude', 'settings.json');
  const ours = () => ((JSON.parse(fs.readFileSync(settings(), 'utf8')).hooks?.PermissionRequest ?? []) as any[]).filter((e) => e.hooks.some((h: any) => String(h.command).includes('# jaffer-managed')));
  const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jaffer"}}}';
  const request = (over: object = {}) => ({ session_id: 'sess-a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build INPUT-SECRET-WORDS' }, permission_suggestions: [{ type: 'addRules', rules: ['SUGGESTION-SECRET'] }], ...over });

  /** `jaffer hook permission-request` as Claude Code runs it: what it printed, how it ended, how long it took. */
  const hookCli = (payload: object, extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [path.join(root, 'dist/cli/jaffer.cjs'), 'hook', 'permission-request'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: env5.userHome, JAFFER_HOME: env5.home, JAFFER_SESSION: '1', JAFFER_NO_HOOKS: '', ...extra } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  /** The next list of pending requests the app hears that has one in it. */
  const nextAsk = () => new Promise<any>((resolve) => {
    const off = app.on('claude.approvals', (d: any) => {
      if (d?.items?.length) (off(), resolve(d.items[d.items.length - 1]));
    });
  });

  beforeAll(async () => {
    env5 = makeEnv();
    // Claude Code connected (the eleven hooks run this home's wrapper), and the setting on
    installHooks(path.join(env5.paths.binDir, 'jaffer'), env5.userHome);
    env5.config.patch({ claude: { approvals: true } });
    app = await ensureDaemon(env5.paths, {
      execPath: process.execPath,
      daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
      cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
      env: { HOME: env5.userHome, SHELL: '/bin/bash', PS1: '$ ', JAFFER_TEST_APPROVAL_WAIT_MS: String(WAIT) },
    });
    await app.call('hello', { client: 'app', protocol: 1 }); // the app's own connection: only it may answer
  }, 30_000);

  afterAll(async () => {
    app?.close();
    const last = await tryConnect(env5.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    env5.cleanup();
  });

  it('installs the blocking PermissionRequest hook at start while the setting is on, and takes it away and back as it changes', async () => {
    expect(ours()).toHaveLength(1);
    expect(ours()[0].hooks[0]).toEqual({ type: 'command', command: `[ "$JAFFER_SESSION" = 1 ] || exit 0; '${env5.paths.binDir}/jaffer' hook permission-request # jaffer-managed`, timeout: 25 });
    await app.call('config.patch', { claude: { approvals: false } });
    await waitUntil(() => ours().length === 0);
    await app.call('config.patch', { claude: { approvals: true } });
    await waitUntil(() => ours().length === 1);
  });

  it('a click on Allow answers the waiting hook: it prints exactly the allow JSON, exits 0, and the app hears the list empty again', async () => {
    const lists: any[] = [];
    app.on('claude.approvals', (d: any) => lists.push(d));
    const ask = nextAsk();
    const run = hookCli(request());
    const a = await ask;
    expect(Object.keys(a).sort()).toEqual(['allowable', 'detail', 'expiresAt', 'id', 'sessionId', 'tool']);
    expect(a).toMatchObject({ sessionId: 'sess-a', tool: 'Bash', detail: 'rm -rf build INPUT-SECRET-WORDS', allowable: true });
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(await app.call('claude.approvals', {}))).toContain(a.id); // a window that just opened reads the list
    expect(await app.call('claude.approval.answer', { id: a.id, decision: 'allow' })).toEqual({ ok: true });
    const r = await run;
    expect(r).toMatchObject({ status: 0, stdout: ALLOW, stderr: '' });
    await waitUntil(() => lists.length > 0 && lists[lists.length - 1].items.length === 0);
    expect(lists[lists.length - 1].answered).toEqual({ sessionId: 'sess-a', tool: 'Bash' }); // (the window counts it as answered)
    expect((await app.call('claude.approvals', {})).items).toEqual([]);
  });

  it('a click on Deny prints exactly the deny JSON', async () => {
    const ask = nextAsk();
    const run = hookCli(request({ tool_name: 'Write', tool_input: { file_path: '/work/app/src/a.ts', content: 'FILE-CONTENT' }, cwd: '/work/app' }));
    const a = await ask;
    expect(a).toMatchObject({ tool: 'Write', detail: 'src/a.ts', allowable: false }); // (the path from the folder Claude works in; a write is never allowable)
    await app.call('claude.approval.answer', { id: a.id, decision: 'deny' });
    expect(await run).toMatchObject({ status: 0, stdout: DENY, stderr: '' });
  });

  it('a decision other than allow or deny, an unknown id, or an answer from another connection is ignored; only the first answer counts', async () => {
    const ask = nextAsk();
    const pending = app.call('claude.approval', request(), 10_000);
    const a = await ask;
    const other = await tryConnect(env5.paths);
    for (const bad of [{ id: a.id, decision: 'yes' }, { id: a.id, decision: 'ALLOW' }, { id: a.id, decision: 'ASK' }, { id: a.id }, { id: 'no-such-id', decision: 'allow' }, { id: [a.id], decision: 'allow' }, null]) {
      expect(await app.call('claude.approval.answer', bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
    expect(await other!.call('claude.approval.answer', { id: a.id, decision: 'allow' })).toEqual({ ok: false }); // (not the app's own connection)
    other!.close();
    expect((await app.call('claude.approvals', {})).items.map((x: any) => x.id)).toEqual([a.id]); // still waiting
    expect(await app.call('claude.approval.answer', { id: a.id, decision: 'deny' })).toEqual({ ok: true });
    expect(await app.call('claude.approval.answer', { id: a.id, decision: 'allow' })).toEqual({ ok: false }); // answered already
    expect(await pending).toEqual({ decision: 'deny' });
  });

  it('Allow is refused for a request that is not shown whole (redacted, cut, a tool with no line): only Deny or "Answer in terminal" work', async () => {
    for (const over of [{ tool_input: { command: 'mysql -pSECRET;rm -rf ~' } }, { tool_input: { command: `echo ${'x'.repeat(300)}` } }, { tool_name: 'mcp__srv__tool', tool_input: { q: 'x' } }, { tool_name: 'Write', tool_input: { file_path: '/work/app/a.ts', content: 'x' }, cwd: '/work/app' }]) {
      const ask = nextAsk();
      const pending = app.call('claude.approval', request(over), 10_000);
      const a = await ask;
      expect(a.allowable, JSON.stringify(over).slice(0, 40)).toBe(false);
      expect(await app.call('claude.approval.answer', { id: a.id, decision: 'allow' })).toEqual({ ok: false });
      expect((await app.call('claude.approvals', {})).items.map((x: any) => x.id)).toEqual([a.id]); // still waiting
      expect(await app.call('claude.approval.answer', { id: a.id, decision: 'deny' })).toEqual({ ok: true });
      expect(await pending).toEqual({ decision: 'deny' });
    }
  });

  it('"Answer in terminal" (ask) lets the hook go at once: it prints nothing, Claude Code\'s own prompt follows, and the request is gone', async () => {
    const ask = nextAsk();
    const run = hookCli(request());
    const a = await ask;
    const t0 = Date.now();
    expect(await app.call('claude.approval.answer', { id: a.id, decision: 'ask' })).toEqual({ ok: true });
    const r = await run;
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(Date.now() - t0).toBeLessThan(WAIT / 2);
    expect((await app.call('claude.approvals', {})).items).toEqual([]);
    expect(await app.call('claude.approval.answer', { id: a.id, decision: 'deny' })).toEqual({ ok: false }); // gone
  });

  it('no click within the wait: the hook prints nothing, exits 0, and the request is gone', async () => {
    const r = await hookCli(request());
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeGreaterThanOrEqual(WAIT - 200);
    expect((await app.call('claude.approvals', {})).items).toEqual([]);
  });

  it('a sixth request while five wait is refused at once, and nothing of a request is kept by the watcher', async () => {
    const before = JSON.stringify((await app.call('claude.state', {})).sessions);
    const five = Array.from({ length: 5 }, (_, i) => app.call('claude.approval', request({ session_id: `s${i}` }), 10_000));
    await waitUntil(async () => (await app.call('claude.approvals', {})).items.length === 5);
    const t0 = Date.now();
    expect(await app.call('claude.approval', request({ session_id: 's6' }), 10_000)).toEqual({ decision: null });
    expect(Date.now() - t0).toBeLessThan(WAIT / 2);
    const list = JSON.stringify(await app.call('claude.approvals', {}));
    for (const word of ['SUGGESTION-SECRET', 'permission_suggestions', 'tool_input', 'hook_event_name']) expect(list, word).not.toContain(word); // (the command shows, as its detail)
    expect(JSON.stringify((await app.call('claude.state', {})).sessions)).toBe(before); // the payload is not the watcher's
    expect(await Promise.all(five)).toEqual(Array(5).fill({ decision: null })); // (they wait out their time)
  });

  it('the setting off: null at once, and the hook prints nothing', async () => {
    await app.call('config.patch', { claude: { approvals: false } });
    try {
      const t0 = Date.now();
      expect(await app.call('claude.approval', request(), 10_000)).toEqual({ decision: null });
      expect(Date.now() - t0).toBeLessThan(WAIT / 2);
      const r = await hookCli(request());
      expect(r).toMatchObject({ status: 0, stdout: '' });
      expect(r.ms).toBeLessThan(WAIT);
    } finally {
      await app.call('config.patch', { claude: { approvals: true } });
    }
  });

  it('turning the setting off while one waits lets it go at once', async () => {
    const ask = nextAsk();
    const pending = app.call('claude.approval', request(), 10_000);
    await ask;
    const t0 = Date.now();
    await app.call('config.patch', { claude: { approvals: false } });
    expect(await pending).toEqual({ decision: null });
    expect(Date.now() - t0).toBeLessThan(WAIT / 2);
    await app.call('config.patch', { claude: { approvals: true } });
  });

  it('Claude Code giving up on the hook (its connection goes) takes the request away: no buttons are left for it', async () => {
    const asker = await tryConnect(env5.paths);
    const ask = nextAsk();
    void asker!.call('claude.approval', request(), 10_000).catch(() => undefined);
    await ask;
    asker!.close();
    await waitUntil(async () => (await app.call('claude.approvals', {})).items.length === 0, WAIT / 2);
  });

  it('without the app (no connection said it is the app), or when its connection goes, the answer is null at once', async () => {
    const other = await tryConnect(env5.paths);
    const ask = nextAsk();
    const pending = other!.call('claude.approval', request(), 10_000);
    await ask;
    const t0 = Date.now();
    app.close();
    expect(await pending).toEqual({ decision: null });
    expect(Date.now() - t0).toBeLessThan(WAIT / 2);
    // no app connected now: nobody to click, so nothing waits
    expect(await other!.call('claude.approval', request(), 10_000)).toEqual({ decision: null });
    expect(await other!.call('claude.approvals', {})).toEqual({ items: [] });
    other!.close();
    app = (await tryConnect(env5.paths))!;
    await app.call('hello', { client: 'app', protocol: 1 });
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

// 1.4.0: a command in any terminal counts, not only in the first. A daemon of its own, with the 30 s a command must run shortened
// (JAFFER_TEST_STAY_AWAKE_AFTER_MS, a test hook that can only shorten it), so that this runs alone and quickly.
describe('the Mac stays awake for a long command in any terminal (bundled daemon, the hold written to a log)', () => {
  let env7: TestEnv;
  let c: RpcClient;
  const log = () => path.join(env7.root, 'hold.log');
  const ops = (): string[] => {
    try {
      return fs.readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).op);
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    env7 = makeEnv();
    fs.writeFileSync(path.join(env7.userHome, '.zshenv'), 'skip_global_compinit=1\n');
    c = await ensureDaemon(env7.paths, {
      execPath: process.execPath,
      daemonScript: path.join(root, 'dist/daemon/jafferd.cjs'),
      cliScript: path.join(root, 'dist/cli/jaffer.cjs'),
      env: { HOME: env7.userHome, SHELL: '/bin/bash', PS1: '$ ', JAFFER_TEST_HOLD_LOG: log(), JAFFER_TEST_STAY_AWAKE_AFTER_MS: '1000' },
    });
    await c.call('session.attach', { cols: 100, rows: 30 });
    await waitUntil(async () => (await c.call('pane.list', {}))[0].alive);
  }, 30_000);

  afterAll(async () => {
    c?.close();
    const last = await tryConnect(env7.paths);
    await last?.call('app.shutdown', {}).catch(() => undefined);
    await sleep(300);
    env7?.cleanup();
  });

  it('a long command in a second terminal holds too, and closing that terminal lets go', async () => {
    await waitUntil(() => ops().length === 0 || ops()[ops().length - 1] === 'release', 25_000);
    const before = ops().length;
    const starts = collect(c, 'pty.start') as { pane: string; cmd: string }[];
    await c.call('pane.split', {});
    await c.call('session.attach', { pane: 'p2' });
    await waitUntil(async () => (await c.call('pane.list', {}))[1]?.alive === true);
    await sleep(800);
    await c.call('pty.write', { pane: 'p2', data: 'sleep 120\r' });
    await waitUntil(() => starts.some((s) => s.pane === 'p2' && s.cmd === 'sleep 120'));
    await waitUntil(() => ops().length === before + 1, 8_000);
    expect(ops()[before]).toBe('hold');
    await c.call('pane.close', { pane: 'p2' });
    await waitUntil(() => ops().length === before + 2, 20_000);
    expect(ops()[before + 1]).toBe('release');
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

describe('the CLI never starts a terminal: it runs only while the app does (bundled CLI, no daemon)', () => {
  it('`jaffer status`, `jaffer daemon start` and `jaffer setup claude` with Jaffer not running say so, and start nothing', async () => {
    const e = makeEnv();
    const cli = (...a: string[]) => spawnSync(process.execPath, [launcher.cliScript!, ...a], { env: { ...process.env, ...launcher.env, HOME: e.userHome, JAFFER_HOME: e.home }, encoding: 'utf8', cwd: e.userHome, timeout: 30_000 });
    try {
      const status = cli('status');
      expect(status.status).toBe(0);
      expect(status.stdout).toMatch(/daemon: not running/);
      expect(status.stdout).toContain('Jaffer is not running. Open Jaffer and run this again.');
      const start = cli('daemon', 'start');
      expect(start.status).toBe(1);
      expect(start.stderr).toContain('Jaffer is not running. Open Jaffer and run this again.');
      const setup = cli('setup', 'claude');
      expect(setup.status).toBe(1);
      expect(setup.stderr).toContain('Jaffer is not running. Open Jaffer and run this again.');
      await sleep(1_500); // (a daemon started in the background would answer by now)
      expect(await tryConnect(e.paths, 300)).toBeNull();
      expect(fs.existsSync(e.paths.socket)).toBe(false);
      expect(fs.existsSync(path.join(e.userHome, '.claude', 'settings.json'))).toBe(false); // and no hooks were written for a `jaffer` that is not there
      // what works without the app still does: taking the hooks away, and the help, which no longer offers to start one
      expect(cli('setup', 'claude', '--remove').status).toBe(0);
      const help = cli('--help').stdout;
      expect(help).toMatch(/jaffer daemon \[status\|stop\]/);
      expect(help).not.toMatch(/daemon \[start|daemon start/);
    } finally {
      const c = await tryConnect(e.paths, 300); // (only if a test above failed: nothing may be left running)
      await c?.call('app.shutdown', {}).catch(() => undefined);
      c?.close();
      e.cleanup();
    }
  }, 60_000);
});
