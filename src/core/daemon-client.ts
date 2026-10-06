import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { JafferPaths } from '../shared/paths';
import { ensureDir, sleep } from '../shared/util';
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

export interface Launcher {
  /** Binary to run (Electron's own binary with ELECTRON_RUN_AS_NODE, or node). */
  execPath: string;
  daemonScript: string;
  cliScript?: string;
  electron?: boolean;
  /** Extra environment for the daemon (tests, packaging). */
  env?: NodeJS.ProcessEnv;
}

/** Start the daemon detached so it outlives whoever launched it (the app, a CLI call, a hook). */
export function launchDaemon(paths: JafferPaths, l: Launcher): void {
  ensureDir(paths.runDir);
  const env: NodeJS.ProcessEnv = { ...process.env, ...l.env, JAFFER_HOME: paths.home };
  if (l.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (l.cliScript) env.JAFFER_CLI_SCRIPT = l.cliScript;
  const child = spawn(l.execPath, [l.daemonScript], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/** Connect to the running daemon, starting one if needed. */
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
