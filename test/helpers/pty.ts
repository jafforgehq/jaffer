import fs from 'node:fs';
import { buildShellSpawn, installShellIntegration } from '../../src/core/session/shell-integration';
import { PtySession, type PtyEvent } from '../../src/core/session/terminal';
import type { TestEnv } from './env';

export function startShell(env: TestEnv, opts: { shell?: string; cols?: number; rows?: number; cwd?: string } = {}): PtySession {
  installShellIntegration(env.paths);
  fs.mkdirSync(env.paths.binDir, { recursive: true });
  const shell = opts.shell ?? '/bin/bash';
  const spawn = buildShellSpawn({
    shell,
    paths: env.paths,
    version: 'test',
    baseEnv: { PATH: process.env.PATH, HOME: env.userHome, LANG: 'en_US.UTF-8', PS1: '$ ', ELECTRON_RUN_AS_NODE: '1' },
    login: false,
  });
  return new PtySession({ file: spawn.file, args: spawn.args, cwd: opts.cwd ?? env.userHome, env: spawn.env, cols: opts.cols ?? 100, rows: opts.rows ?? 30 });
}

export function waitFor<T>(session: PtySession, pred: (e: PtyEvent) => T | false | undefined | null, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for pty event; screen:\n${session.readScreen(20)}`));
    }, ms);
    const off = session.events.on((e) => {
      const r = pred(e);
      if (r) {
        clearTimeout(t);
        off();
        resolve(r as T);
      }
    });
  });
}

export async function untilReady(session: PtySession, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!session.promptReady) {
    if (Date.now() - t0 > ms) throw new Error(`shell never became ready; screen:\n${session.readScreen(20)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
