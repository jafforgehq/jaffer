import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { detachedSpawnArgs, ensureDaemon, ownedSpawnArgs, startOwnedDaemon, tryConnect, type Launcher, type SpawnFn } from '../src/core/daemon-client';
import { sleep } from '../src/shared/util';

/**
 * The app owns its terminal host: it starts `jafferd` as its own child (not detached, `JAFFER_OWNED=1`, its stdin a pipe the app holds and
 * never writes), and the end of that pipe, however it comes (the app quits, crashes or is killed), ends the daemon, its shell with it.
 * Without the flag nothing changes: the tests and `ensureDaemon` start the daemon with `stdio: 'ignore'`.
 *
 * Real processes against the daemon as the build bundles it. The bundle is built here, next to the shipped one under a name of its own:
 * the other test files rebuild `dist/daemon/jafferd.cjs` while theirs run, and a daemon started while the file is being rewritten could
 * read half of it.
 */
const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'dist', 'daemon', `jafferd-owned-test-${process.pid}.cjs`);
const envs: TestEnv[] = [];
/** Every process a test here starts (daemons, shells, stand-in parents): whatever a failing test left is killed at the end. */
const started = new Set<number>();

beforeAll(async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // the same options as scripts/build.mjs gives the daemon target
  await build({
    entryPoints: [path.join(root, 'src/daemon/main.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['@lydell/node-pty', 'electron'],
    define: { __JAFFER_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await sleep(200);
  for (const e of envs) e.cleanup();
  fs.rmSync(bundle, { force: true });
});

function env(): TestEnv {
  const e = makeEnv();
  envs.push(e);
  return e;
}

function launcherFor(e: TestEnv): Launcher {
  return { execPath: process.execPath, daemonScript: bundle, env: { HOME: e.userHome, SHELL: '/bin/bash', PS1: '$ ' } };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** Connects, attaches and waits for the shell: its pid, for the check that it is gone afterwards. */
async function shellOf(e: TestEnv): Promise<{ shellPid: number; close: () => void; call: (m: string, p?: unknown) => Promise<any> }> {
  let c = await tryConnect(e.paths, 300);
  await waitUntil(async () => !!(c ??= await tryConnect(e.paths, 300)), 15_000, 'the daemon to answer');
  await c!.call('session.attach', { cols: 100, rows: 30 });
  await waitUntil(async () => (await c!.call('pane.list', {}))[0]?.alive === true, 10_000, 'the shell');
  const shellPid = (await c!.call('pane.list', {}))[0].pid as number;
  started.add(shellPid);
  return { shellPid, close: () => c!.close(), call: (m, p = {}) => c!.call(m, p) };
}

async function screen(call: (m: string, p?: unknown) => Promise<any>): Promise<string> {
  return ((await call('session.snapshot')) as { data: string }).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

describe('the app owns its terminal host (bundled daemon, real processes)', () => {
  it('with JAFFER_OWNED=1, closing its stdin ends it: exit 0, the socket and the shell are gone, and the flag never reaches the shell', async () => {
    const e = env();
    const s = ownedSpawnArgs(e.paths, launcherFor(e));
    const child = spawn(s.command, s.args, s.options);
    started.add(child.pid!);
    const exited = exitOf(child);
    const { shellPid, close, call } = await shellOf(e);
    // the flag is the app's word to this one daemon: the shell (and a test or a daemon started from it) never sees it
    await call('pty.write', { data: 'echo "owned=${JAFFER_OWNED-unset}"\r' });
    await waitUntil(async () => /^owned=unset/m.test(await screen(call)), 10_000, 'the shell to answer');
    close();
    child.stdin!.end(); // what the app's quit does, and what its death does to the pipe
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(e.paths.socket)).toBe(false);
    await waitUntil(() => !alive(shellPid), 10_000, 'the shell to end');
    expect(fs.readFileSync(e.paths.logFile, 'utf8')).toMatch(/shutting down/);
  }, 40_000);

  it('without the flag its stdin closing changes nothing: it runs on until app.shutdown', async () => {
    const e = env();
    const child = spawn(process.execPath, [bundle], {
      env: { ...process.env, ...launcherFor(e).env, JAFFER_HOME: e.home, JAFFER_OWNED: undefined },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    started.add(child.pid!);
    const exited = exitOf(child);
    const { shellPid, close, call } = await shellOf(e);
    child.stdin!.end();
    await sleep(1_500);
    expect(child.exitCode).toBeNull();
    expect((await call('hello')).pid).toBe(child.pid);
    expect((await call('pane.list'))[0]).toMatchObject({ pid: shellPid, alive: true });
    await call('app.shutdown');
    close();
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(e.paths.socket)).toBe(false);
    await waitUntil(() => !alive(shellPid), 10_000, 'the shell to end');
  }, 40_000);

  it('a parent that is killed (SIGKILL, as a crash or a Force Quit of the app) leaves no daemon and no shell behind', async () => {
    const e = env();
    // a stand-in for the app: it starts the daemon exactly as the app does, holds the pipe, and is then killed
    const spec = path.join(e.root, 'spawn.json');
    fs.writeFileSync(spec, JSON.stringify(ownedSpawnArgs(e.paths, launcherFor(e))));
    const script = path.join(e.root, 'stand-in-app.cjs');
    fs.writeFileSync(
      script,
      `const { spawn } = require('node:child_process');
const s = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const child = spawn(s.command, s.args, s.options);
process.stdout.write(child.pid + '\\n');
setInterval(() => {}, 1000);
`,
    );
    const app = spawn(process.execPath, [script, spec], { stdio: ['ignore', 'pipe', 'ignore'] });
    started.add(app.pid!);
    const daemonPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the stand-in never said its child')), 15_000);
      app.stdout!.on('data', (d) => (clearTimeout(t), resolve(Number(String(d).trim()))));
    });
    started.add(daemonPid);
    const { shellPid, close, call } = await shellOf(e);
    expect((await call('hello')).pid).toBe(daemonPid);
    close();
    app.kill('SIGKILL');
    await waitUntil(() => !alive(daemonPid), 10_000, 'the daemon to end with its parent');
    expect(fs.existsSync(e.paths.socket)).toBe(false); // it ended as a stop, not a crash: it let go of the socket
    await waitUntil(() => !alive(shellPid), 10_000, 'the shell to end');
  }, 40_000);

  it('the app\'s start connects to its own child, and the app\'s quit ends it with 0 and takes the shell with it', async () => {
    const e = env();
    const owned = await startOwnedDaemon(e.paths, launcherFor(e));
    started.add(owned.pid);
    expect((await owned.client.call('hello', {})).pid).toBe(owned.pid);
    const { shellPid, close } = await shellOf(e);
    close();
    expect(owned.ended).toBe(false);
    expect(await owned.stop()).toEqual({ code: 0, signal: null });
    expect(owned.ended).toBe(true);
    expect(fs.existsSync(e.paths.socket)).toBe(false);
    await waitUntil(() => !alive(shellPid), 10_000, 'the shell to end');
    expect(await owned.stop()).toEqual({ code: 0, signal: null }); // a second quit has nothing left to do
  }, 40_000);

  it('a client\'s app.shutdown (`jaffer reset`, `jaffer daemon stop`) ends the owned child with 0: what the app takes as its cue to quit', async () => {
    const e = env();
    const owned = await startOwnedDaemon(e.paths, launcherFor(e));
    started.add(owned.pid);
    const other = (await tryConnect(e.paths))!;
    await other.call('app.shutdown', {});
    other.close();
    expect(await owned.exited).toEqual({ code: 0, signal: null });
    expect(owned.ended).toBe(true);
  }, 40_000);

  it('the start never takes a daemon that is not its own: with another one on the socket, its child stops and the start fails', async () => {
    const e = env();
    const l = launcherFor(e);
    const other = await ensureDaemon(e.paths, l);
    const otherPid = (await other.call('hello', {})).pid as number;
    started.add(otherPid);
    try {
      const t0 = Date.now();
      await expect(startOwnedDaemon(e.paths, l)).rejects.toThrow(/stopped while it started/);
      expect(Date.now() - t0).toBeLessThan(10_000); // it did not wait out the whole start
      expect((await other.call('hello', {})).pid).toBe(otherPid); // and the other one was left alone
    } finally {
      await other.call('app.shutdown', {}).catch(() => undefined);
      other.close();
    }
    await waitUntil(() => !alive(otherPid), 10_000, 'the other daemon to end');
  }, 40_000);
});

describe('how the app starts its child, and how ensureDaemon starts a detached one (spawn arguments; no process)', () => {
  const paths = env().paths;
  const launcher: Launcher = { execPath: '/Applications/Jaffer.app/Contents/MacOS/Jaffer', daemonScript: '/app/dist/daemon/jafferd.cjs', cliScript: '/app/dist/cli/jaffer.cjs', electron: true, env: { HOME: '/Users/someone' } };

  it('the owned child: not detached, the app\'s binary as node with the daemon script, its stdin a pipe, JAFFER_OWNED=1, JAFFER_HOME, JAFFER_CLI_SCRIPT and the kill switch', () => {
    const s = ownedSpawnArgs(paths, launcher, 7);
    expect(s.command).toBe(launcher.execPath);
    expect(s.args).toEqual([launcher.daemonScript]);
    expect(s.options.detached).toBeFalsy();
    expect(s.options.stdio).toEqual(['pipe', 7, 7]); // its output goes to the log
    expect(s.options.env).toMatchObject({ JAFFER_OWNED: '1', JAFFER_HOME: paths.home, JAFFER_CLI_SCRIPT: launcher.cliScript, ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/someone', JAFFER_NO_LAUNCHCTL: '1' });
    expect(ownedSpawnArgs(paths, launcher).options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(ownedSpawnArgs(paths, { ...launcher, electron: false }).options.env!.ELECTRON_RUN_AS_NODE).toBe(process.env.ELECTRON_RUN_AS_NODE); // (not added for node)
  });

  it('the detached daemon of ensureDaemon (tests, the dev bridge): detached, nothing on its stdin, and never JAFFER_OWNED, even when the environment has it', () => {
    const s = detachedSpawnArgs(paths, { ...launcher, env: { ...launcher.env, JAFFER_OWNED: '1' } });
    expect(s.command).toBe(launcher.execPath);
    expect(s.args).toEqual([launcher.daemonScript]);
    expect(s.options.detached).toBe(true);
    expect(s.options.stdio).toBe('ignore');
    expect(s.options.env).toMatchObject({ JAFFER_HOME: paths.home, JAFFER_CLI_SCRIPT: launcher.cliScript, ELECTRON_RUN_AS_NODE: '1' });
    expect(s.options.env).not.toHaveProperty('JAFFER_OWNED');
  });

  /** A child that runs and never answers on the socket; it ends when it is killed. */
  function silentChild() {
    const child = Object.assign(new EventEmitter(), { pid: 2_000_000_001, stdin: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kills: [] as (string | number | undefined)[] });
    (child as any).kill = (sig?: NodeJS.Signals) => {
      child.kills.push(sig);
      setTimeout(() => ((child.signalCode = sig ?? 'SIGTERM'), child.emit('exit', null, child.signalCode)), 5);
      return true;
    };
    return child;
  }

  it('a child that never answers: the start gives up with "Could not start", names the log, and kills the child', async () => {
    const e = env();
    const child = silentChild();
    const calls: { command: string; args: readonly string[]; options: any }[] = [];
    const fakeSpawn: SpawnFn = (command, args, options) => (calls.push({ command, args, options }), child as unknown as ChildProcess);
    const t0 = Date.now();
    await expect(startOwnedDaemon(e.paths, launcherFor(e), { waitMs: 500, spawn: fakeSpawn })).rejects.toThrow(new RegExp(`Could not start.*${e.paths.logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.env.JAFFER_OWNED).toBe('1');
    expect(child.kills).toEqual(['SIGKILL']);
  });

  it('a child that ends while starting: the start fails at once, with how it ended', async () => {
    const e = env();
    const child = silentChild();
    setTimeout(() => ((child.exitCode = 1), child.emit('exit', 1, null)), 50);
    const t0 = Date.now();
    await expect(startOwnedDaemon(e.paths, launcherFor(e), { waitMs: 10_000, spawn: () => child as unknown as ChildProcess })).rejects.toThrow(/stopped while it started \(exit code 1/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('ensureDaemon gives up with "Could not start" when no daemon answers, naming the log', async () => {
    const e = env();
    const spawned: unknown[] = [];
    const l: Launcher = { ...launcherFor(e), spawn: (_c, _a, o) => (spawned.push(o), { unref: () => undefined }) };
    await expect(ensureDaemon(e.paths, l, 400)).rejects.toThrow(/Could not start/);
    expect(spawned).toHaveLength(1);
  });
});
