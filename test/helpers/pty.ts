import fs from 'node:fs';
import path from 'node:path';
import { buildShellSpawn, installShellIntegration } from '../../src/core/session/shell-integration';
import { PtySession, type PtyEvent, type PtyOptions } from '../../src/core/session/terminal';
import type { TestEnv } from './env';

export function startShell(env: TestEnv, opts: { shell?: string; cols?: number; rows?: number; cwd?: string; foregroundGroup?: PtyOptions['foregroundGroup'] } = {}): PtySession {
  installShellIntegration(env.paths);
  // Debian/Ubuntu's global zshrc runs compinit, which prompts on CI runners; opt out via the user's own .zshenv
  // (this doubles as a check that the integration sources the user's real dotfiles).
  fs.writeFileSync(path.join(env.userHome, '.zshenv'), 'skip_global_compinit=1\n');
  fs.mkdirSync(env.paths.binDir, { recursive: true });
  const shell = opts.shell ?? '/bin/bash';
  const spawn = buildShellSpawn({
    shell,
    paths: env.paths,
    version: 'test',
    baseEnv: { PATH: process.env.PATH, HOME: env.userHome, LANG: 'en_US.UTF-8', PS1: '$ ', ELECTRON_RUN_AS_NODE: '1' },
    login: false,
  });
  return new PtySession({ file: spawn.file, args: spawn.args, cwd: opts.cwd ?? env.userHome, env: spawn.env, cols: opts.cols ?? 100, rows: opts.rows ?? 30, ...(opts.foregroundGroup ? { foregroundGroup: opts.foregroundGroup } : {}) });
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

/** Type a command at a ready prompt and wait for it to finish, as a person would: how a test runs something and reads its output. */
export async function runInShell(session: PtySession, cmd: string, ms = 15_000): Promise<Extract<PtyEvent, { type: 'command' }>> {
  await untilReady(session);
  const done = waitFor(session, (e) => (e.type === 'command' ? e : false), ms);
  session.write(cmd + '\r');
  const e = await done;
  await untilReady(session);
  return e;
}

export async function untilReady(session: PtySession, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!session.promptReady) {
    if (Date.now() - t0 > ms) throw new Error(`shell never became ready; screen:\n${session.readScreen(20)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Kill a test shell and wait until it has really exited. A shell that is still alive can write into the temporary HOME
 * (zsh saves its history on the way out), which made the folder's removal fail with ENOTEMPTY on macOS CI.
 */
export async function stopShell(session: PtySession, graceMs = 1500, killMs = 5000): Promise<void> {
  if (session.alive) {
    let off = () => {};
    const gone = new Promise<void>((resolve) => {
      off = session.events.on((e) => {
        if (e.type === 'exit') resolve();
      });
    });
    const within = (ms: number) => Promise.race([gone, new Promise<void>((r) => setTimeout(r, ms))]);
    session.kill();
    await within(graceMs);
    if (session.alive) {
      session.kill('SIGKILL');
      await within(killMs);
    }
    off();
  }
  session.dispose();
}
