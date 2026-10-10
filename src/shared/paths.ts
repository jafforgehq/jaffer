import os from 'node:os';
import path from 'node:path';

/**
 * Everything Jaffer persists lives under one directory (default ~/.jaffer),
 * overridable with JAFFER_HOME so tests and side-by-side installs stay isolated.
 */
export interface JafferPaths {
  home: string;
  config: string;
  runDir: string;
  socket: string;
  logFile: string;
  sessionDir: string;
  sessionState: string;
  screenSnapshot: string;
  shellDir: string;
  binDir: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAFFER_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), '.jaffer');
}

export function makePaths(home: string = resolveHome()): JafferPaths {
  const runDir = path.join(home, 'run');
  const sessionDir = path.join(home, 'session');
  return {
    home,
    config: path.join(home, 'config.json'),
    runDir,
    // Unix socket paths are limited to ~104 bytes on macOS; keep the name short.
    socket: path.join(runDir, 'jafferd.sock'),
    logFile: path.join(runDir, 'jafferd.log'),
    sessionDir,
    sessionState: path.join(sessionDir, 'state.json'),
    screenSnapshot: path.join(sessionDir, 'screen.json'),
    shellDir: path.join(home, 'shell'),
    binDir: path.join(home, 'bin'),
  };
}
