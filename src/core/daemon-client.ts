import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import type { JafferPaths } from '../shared/paths';
import { ensureDir, rotateLog, sleep } from '../shared/util';
import { RpcClient } from './rpc';

export async function tryConnect(paths: JafferPaths, timeoutMs = 1200): Promise<RpcClient | null> {
  if (!fs.existsSync(paths.socket)) return null;
  const c = new RpcClient(paths.socket);
  try {
    await c.connect(timeoutMs);
    return c;
  } catch {
    c.close();
    return null;
  }
}

/**
 * Waits up to `ms` for nothing to answer on the socket any more (a session on its way out). True as soon as nothing answers (at once when
 * nothing did); false when something still answers once the wait is over.
 */
export async function waitForSocketGone(paths: JafferPaths, ms: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const c = await tryConnect(paths, 300);
    if (!c) return true;
    c.close();
    if (Date.now() - t0 >= ms) return false;
    await sleep(200);
  }
}

export interface Launcher {
  /** Binary to run (Electron's own binary with ELECTRON_RUN_AS_NODE, or node). */
  execPath: string;
  daemonScript: string;
  cliScript?: string;
  electron?: boolean;
  /** Extra environment for the daemon (tests, packaging). */
  env?: NodeJS.ProcessEnv;
  /** How the detached daemon is spawned (tests). */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions & { env?: NodeJS.ProcessEnv }) => { unref(): void };
}

export interface DaemonSpawn {
  command: string;
  args: string[];
  options: SpawnOptions & { env: NodeJS.ProcessEnv };
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

function daemonEnv(paths: JafferPaths, l: Launcher): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...l.env, JAFFER_HOME: paths.home };
  delete env.JAFFER_OWNED; // only the app's own child gets it, from ownedSpawnArgs
  if (l.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (l.cliScript) env.JAFFER_CLI_SCRIPT = l.cliScript;
  return env;
}

/**
 * How the app starts its terminal host: as its own child (not detached), with `JAFFER_OWNED=1` and its stdin a pipe the app holds and
 * never writes. The daemon stops when that pipe ends, which it does however the app goes (it quits, crashes or is killed), so neither
 * the daemon nor the shell outlives the app. `out` is where its stdout and stderr go (the log, opened by the caller).
 */
export function ownedSpawnArgs(paths: JafferPaths, l: Launcher, out: number | 'ignore' = 'ignore'): DaemonSpawn {
  return { command: l.execPath, args: [l.daemonScript], options: { stdio: ['pipe', out, out], env: { ...daemonEnv(paths, l), JAFFER_OWNED: '1' } } };
}

/** The daemon that `ensureDaemon` starts (the tests and the dev bridge only): detached, nothing on its stdin, never owned. */
export function detachedSpawnArgs(paths: JafferPaths, l: Launcher): DaemonSpawn {
  return { command: l.execPath, args: [l.daemonScript], options: { detached: true, stdio: 'ignore', env: daemonEnv(paths, l) } };
}

/** Start the daemon, detached, so it outlives whoever started it. Only for the tests and the dev bridge: the app starts its own child. */
export function launchDaemon(paths: JafferPaths, l: Launcher): void {
  ensureDir(paths.runDir);
  const s = detachedSpawnArgs(paths, l);
  const child = (l.spawn ?? nodeSpawn)(s.command, s.args, s.options);
  child.unref();
}

/** Connect to the running daemon, starting a detached one if needed (the tests and the dev bridge; the app uses `startOwnedDaemon`). */
export async function ensureDaemon(paths: JafferPaths, l: Launcher, waitMs = 12_000): Promise<RpcClient> {
  const existing = await tryConnect(paths);
  if (existing) return existing;
  launchDaemon(paths, l);
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(120);
    const c = await tryConnect(paths, 600);
    if (c) return c;
  }
  throw new Error(`Could not start the Jaffer session daemon (see ${paths.logFile}).`);
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** How long the app's quit waits for its child to end before it kills it. */
export const QUIT_WAIT_MS = 3_000;

/** The app's own terminal host, running. */
export interface OwnedDaemon {
  readonly pid: number;
  /** The app's connection to it (a new one after `reconnect`). */
  readonly client: RpcClient;
  /** Resolves with how it ended, whoever ended it. */
  readonly exited: Promise<ChildExit>;
  readonly ended: boolean;
  /**
   * The app's quit: ends the pipe (the daemon's cue to stop: it ends the shell and lets go of the socket), waits up to `ms`, then kills it.
   * Resolves once it has ended; a second call has nothing to do.
   */
  stop(ms?: number): Promise<ChildExit>;
  /** Connects again to this same child (the connection went while it runs); null when it does not answer as itself in time. */
  reconnect(timeoutMs?: number): Promise<RpcClient | null>;
  /** Kills it at once (SIGKILL: its shell gets the hangup of a closed terminal), for a child that runs but cannot be reached. */
  kill(): void;
}

function describeExit(e: ChildExit): string {
  return e.signal ? `signal ${e.signal}` : e.code === null ? 'it could not be started' : `exit code ${e.code}`;
}

/** Connects to the daemon that answers on the socket, if it is the process `pid` (never another one: an older Jaffer's, a test's). */
async function connectTo(paths: JafferPaths, pid: number | undefined): Promise<RpcClient | null> {
  const c = await tryConnect(paths, 600);
  if (!c) return null;
  const hello = await c.call<{ pid?: number }>('hello', { client: 'app', protocol: 1 }, 2_000).catch(() => null);
  if (pid !== undefined && hello?.pid === pid) return c;
  c.close();
  return null;
}

/**
 * Start the app's own terminal host (see `ownedSpawnArgs`) and connect to it. Only this child is taken: a daemon of another process that
 * answers on the socket is not (the child, finding the socket taken, ends at once, and so does the start). A child that does not answer
 * within `waitMs` is killed and the start fails.
 */
export async function startOwnedDaemon(paths: JafferPaths, l: Launcher, o: { waitMs?: number; spawn?: SpawnFn } = {}): Promise<OwnedDaemon> {
  ensureDir(paths.runDir);
  rotateLog(paths.logFile);
  let out: number | 'ignore' = 'ignore';
  try {
    out = fs.openSync(paths.logFile, 'a', 0o600);
  } catch {
    /* no log: what it prints goes nowhere */
  }
  const s = ownedSpawnArgs(paths, l, out);
  let child: ChildProcess;
  try {
    child = (o.spawn ?? nodeSpawn)(s.command, s.args, s.options);
  } finally {
    if (typeof out === 'number') fs.closeSync(out); // (the child has its own copy)
  }
  child.stdin?.on('error', () => undefined); // a pipe to a child that has gone: nothing to say
  let ended: ChildExit | null = null;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('exit', (code, signal) => resolve((ended ??= { code, signal })));
    // (could not be started at all, e.g. a binary that is not there: there will be no 'exit')
    child.on('error', () => void (child.pid === undefined && resolve((ended ??= { code: null, signal: null }))));
  });

  const waitMs = o.waitMs ?? 12_000;
  const t0 = Date.now();
  let client: RpcClient | null = null;
  while (!client) {
    if (ended) throw new Error(`Jaffer's terminal stopped while it started (${describeExit(ended)}; see ${paths.logFile}).`);
    if (Date.now() - t0 >= waitMs) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone already */
      }
      throw new Error(`Could not start Jaffer's terminal (see ${paths.logFile}).`);
    }
    await Promise.race([sleep(120), exited]);
    if (!ended) client = await connectTo(paths, child.pid);
  }

  let current: RpcClient = client;
  return {
    pid: child.pid!,
    get client() {
      return current;
    },
    exited,
    get ended() {
      return ended !== null;
    },
    async stop(ms = QUIT_WAIT_MS) {
      current.close();
      if (ended) return ended;
      try {
        child.stdin?.end();
      } catch {
        /* the pipe is gone: so is the child, or it soon is */
      }
      const done = await Promise.race([exited, sleep(ms).then(() => null)]);
      if (done) return done;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone meanwhile */
      }
      return (await Promise.race([exited, sleep(2_000).then(() => null)])) ?? { code: null, signal: 'SIGKILL' };
    },
    async reconnect(timeoutMs = 3_000) {
      const t1 = Date.now();
      while (!ended && Date.now() - t1 < timeoutMs) {
        const c = await connectTo(paths, child.pid);
        if (c) return (current = c);
        await sleep(200);
      }
      return null;
    },
    kill() {
      if (ended) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone meanwhile */
      }
    },
  };
}
