import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { ensureDir, rotateLog } from '../shared/util';
import { RpcClient } from '../core/rpc';
import { JafferService } from './service';
import { makeShutdown, SHUTDOWN_DEADLINE_MS, watchParent } from './shutdown';
import { VERSION } from '../core/version';

/**
 * Entry point of the terminal host (jafferd). The app starts it as its own child with `JAFFER_OWNED=1` and a pipe on its stdin: when that
 * pipe ends (the app quits, crashes or is killed) the daemon ends too, and the shell with it. Without the flag (the tests, `ensureDaemon`,
 * the dev bridge) it runs until `app.shutdown` or a signal.
 */

async function alreadyRunning(socket: string): Promise<boolean> {
  const c = new RpcClient(socket);
  try {
    await c.connect(800);
    await c.call('hello', {}, 1500);
    c.close();
    return true;
  } catch {
    c.close();
    return false;
  }
}

async function main(): Promise<void> {
  const owned = process.env.JAFFER_OWNED === '1';
  delete process.env.JAFFER_OWNED; // the app's word to this one process: never handed on (the shell, `claude auth`, a daemon started from the shell)
  const paths = makePaths();
  ensureDir(paths.runDir);
  rotateLog(paths.logFile); // keep the log bounded: start fresh when it grows past 5 MB
  const logFd = fs.openSync(paths.logFile, 'a', 0o600);
  const log = (msg: string) => fs.writeSync(logFd, `${new Date().toISOString()} ${msg}\n`);
  process.on('uncaughtException', (e) => log(`uncaughtException: ${e?.stack ?? e}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e as Error)?.stack ?? e}`));

  if (await alreadyRunning(paths.socket)) {
    log('another daemon is already running; exiting');
    process.exit(0);
  }

  const cliScript = process.env.JAFFER_CLI_SCRIPT ?? path.join(__dirname, '..', 'cli', 'jaffer.cjs');
  const service = new JafferService({ paths, version: VERSION, cliScript: fs.existsSync(cliScript) ? cliScript : undefined, log });
  // The exit code: 0 for a deliberate end (`app.shutdown`, the end of the app's pipe), 143 for SIGTERM and 130 for SIGINT, the shell's own
  // 128 + number. The first reason wins, the shell is let go before the exit, and a stop that hangs ends at a deadline (see shutdown.ts).
  const shutdown = makeShutdown({ stop: () => service.stop(), exit: (code) => process.exit(code), log, deadlineMs: SHUTDOWN_DEADLINE_MS });
  service.onShutdown.fn = () => shutdown('rpc', 0, 50); // (claimed at once; the stop begins once the reply has gone out)
  process.on('SIGTERM', () => shutdown('SIGTERM', 143));
  process.on('SIGINT', () => shutdown('SIGINT', 130));
  process.on('SIGHUP', () => undefined); // (a terminal that started it by hand closing is not an end: the app's pipe, or a client, is)

  await service.start();
  log(`ready pid=${process.pid}${owned ? ' (the app\'s own)' : ''}`);
  // (watched once started: a pipe that ended meanwhile still reads as ended now, and the shell that just started is let go of at once)
  if (owned) watchParent(process.stdin, () => shutdown('the app closed its pipe', 0));
}

main().catch((e) => {
  try {
    fs.appendFileSync(makePaths().logFile, `fatal: ${e?.stack ?? e}\n`);
  } catch {
    /* nothing more to do */
  }
  process.exit(1);
});
