import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { JafferPaths } from '../shared/paths';
import { ensureDir, sleep } from '../shared/util';
import { RpcClient } from './rpc';
import { agentPaths, execLaunchctl, LaunchAgent } from './service/launch-agent';
import { isDefaultHome } from './session/caffeinate';

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

/** The login agent, as far as starting the daemon goes (`daemonAgent` makes one from a `LaunchAgent`). */
export interface DaemonAgent {
  /** The person turned it on: its plist is on disk. */
  installed(): boolean;
  /** Start the job now; true when launchd did. */
  kickstart(): Promise<boolean>;
  /** Load the job from its plist (its RunAtLoad starts the daemon); true when launchd did. */
  bootstrap(): Promise<boolean>;
  /** launchd runs a process for the job right now (`launchctl print` shows its pid). */
  running(): Promise<boolean>;
}

export interface Launcher {
  /** Binary to run (Electron's own binary with ELECTRON_RUN_AS_NODE, or node). */
  execPath: string;
  daemonScript: string;
  cliScript?: string;
  electron?: boolean;
  /** Extra environment for the daemon (tests, packaging). */
  env?: NodeJS.ProcessEnv;
  /**
   * The login agent that owns the daemon when the person turned it on. Left out: the real one, for the person's own home on macOS only
   * (`defaultDaemonAgent`); `null`: none. Tests pass a fake, so they never run `launchctl`.
   */
  agent?: DaemonAgent | null;
  /** How the detached daemon is spawned (tests). */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions & { env?: NodeJS.ProcessEnv }) => { unref(): void };
  /** How long launchd gets to bring the daemon up before it is spawned detached (default `LAUNCHD_GRACE_MS`; tests). */
  launchdGraceMs?: number;
  /** The clock of the wait for the daemon (tests): what time it is, and waiting. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

/**
 * How long launchd gets, once it took the start, before the app or the CLI starts the daemon itself: when no daemon answers by then and
 * launchd shows no process for it (a daemon that cannot start crash-loops under launchd, which throttles it; the person may have
 * disallowed it in Login Items), the session must not depend on launchd.
 */
export const LAUNCHD_GRACE_MS = 6_000;

/**
 * While launchd took the start and no daemon answers, `kickstart` is asked again this often. One that lands while the old daemon is
 * still exiting (the session was just restarted: launchd's throttle) starts nothing, since the job's process still runs, and the one
 * that ends with 0 is not brought back.
 */
export const KICKSTART_AGAIN_MS = 2_000;

/** A `DaemonAgent` from a `LaunchAgent` and where its plist is. */
export function daemonAgent(a: { agent: LaunchAgent; plistPath: string; exists?: (file: string) => boolean }): DaemonAgent {
  const exists = a.exists ?? ((f: string) => fs.existsSync(f));
  return {
    installed: () => exists(a.plistPath),
    kickstart: () => a.agent.kickstart(),
    bootstrap: () => a.agent.bootstrap(a.plistPath),
    running: async () => (await a.agent.runningPid()) !== null,
  };
}

/**
 * The real agent, with the real `launchctl`: only on macOS and only for the person's own `~/.jaffer` (`isDefaultHome`). Any other home (a
 * test, a development home) has none, so it never runs `launchctl`.
 */
export function defaultDaemonAgent(home: string): DaemonAgent | null {
  if (process.platform !== 'darwin' || !isDefaultHome(home)) return null;
  try {
    const { plistPath } = agentPaths({ home, userHome: os.userInfo().homedir });
    return daemonAgent({ agent: new LaunchAgent({ launchctl: execLaunchctl(), uid: process.getuid!(), fs }), plistPath });
  } catch {
    return null;
  }
}

function agentOf(paths: JafferPaths, l: Launcher): DaemonAgent | null {
  return l.agent === undefined ? defaultDaemonAgent(paths.home) : l.agent;
}

/** Start the daemon detached so it outlives whoever launched it (the app, a CLI call, a hook). */
function spawnDetached(paths: JafferPaths, l: Launcher): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...l.env, JAFFER_HOME: paths.home };
  if (l.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (l.cliScript) env.JAFFER_CLI_SCRIPT = l.cliScript;
  delete env.JAFFER_LAUNCHD; // a daemon spawned here is never launchd's job (a CLI run inside a launchd-run session inherits the marker)
  const child = (l.spawn ?? nodeSpawn)(l.execPath, [l.daemonScript], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/**
 * Start the daemon. With the login agent installed (the person's switch, the default home only), launchd starts it: `kickstart` for a
 * job it knows, and a plist it does not know (the switch was turned on in a daemon that was not launchd's, or after a person's
 * `launchctl bootout`) is bootstrapped first (its RunAtLoad starts the daemon). Which way it went is decided by what launchd answered, not
 * by `status` (a loaded job with no process reads as not loaded); only when launchd will not start it, the detached spawn as without the
 * agent. Without the agent, the detached spawn.
 */
export async function launchDaemon(paths: JafferPaths, l: Launcher): Promise<'launchd' | 'spawned'> {
  ensureDir(paths.runDir);
  const agent = agentOf(paths, l);
  if (agent?.installed()) {
    if (await agent.kickstart()) return 'launchd';
    if (await agent.bootstrap()) {
      await agent.kickstart(); // (RunAtLoad has started it already; this does not start a second one)
      return 'launchd';
    }
  }
  spawnDetached(paths, l);
  return 'spawned';
}

/** Connect to the running daemon, starting one if needed. */
export async function ensureDaemon(paths: JafferPaths, l: Launcher, waitMs = 12_000): Promise<RpcClient> {
  const existing = await tryConnect(paths);
  if (existing) return existing;
  const agent = agentOf(paths, l);
  const clock = l.clock ?? { now: Date.now, sleep };
  let spawned = (await launchDaemon(paths, { ...l, agent })) === 'spawned';
  const t0 = clock.now();
  let kickedAt = t0;
  const grace = l.launchdGraceMs ?? LAUNCHD_GRACE_MS;
  while (clock.now() - t0 < waitMs) {
    await clock.sleep(120);
    const c = await tryConnect(paths, 600);
    if (c) return c;
    if (spawned || !agent) continue;
    // the agent's wrapper takes the agent away when the app it was written for is gone (moved, deleted): then launchd starts nothing.
    // Or launchd took the start and no daemon came: with no process of launchd's for it, the daemon is spawned here (its own start
    // rewrites the wrapper, and a launchd instance that starts later finds the socket taken and exits 0, which launchd leaves alone).
    if (!agent.installed() || (clock.now() - t0 >= grace && !(await agent.running()))) {
      spawnDetached(paths, l);
      spawned = true;
    } else if (clock.now() - kickedAt >= KICKSTART_AGAIN_MS) {
      // nothing answers yet: the kickstart may have landed while the old daemon was still exiting, and started nothing (see above)
      kickedAt = clock.now();
      await agent.kickstart().catch(() => false);
    }
  }
  throw new Error(`Could not start the Jaffer session daemon (see ${paths.logFile}).`);
}
