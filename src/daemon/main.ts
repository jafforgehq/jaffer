import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { ensureDir } from '../shared/util';
import { RpcClient } from '../core/rpc';
import { JafferService } from './service';
import { VERSION } from '../core/version';

/** Entry point of the long-lived session daemon (jafferd). */

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
  const paths = makePaths();
  ensureDir(paths.runDir);
  // Keep the log bounded: start fresh when it grows past 5 MB.
  try {
    if (fs.statSync(paths.logFile).size > 5 * 1024 * 1024) fs.renameSync(paths.logFile, paths.logFile + '.1');
  } catch {
    /* no log yet */
  }
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
  const shutdown = async (why: string) => {
    log(`shutting down (${why})`);
    await service.stop().catch((e) => log(`stop error: ${e}`));
    process.exit(0);
  };
  service.onShutdown.fn = () => void shutdown('rpc');
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => undefined); // survive the launching terminal closing

  await service.start();
  log(`ready pid=${process.pid}`);
}

main().catch((e) => {
  try {
    fs.appendFileSync(makePaths().logFile, `fatal: ${e?.stack ?? e}\n`);
  } catch {
    /* nothing more to do */
  }
  process.exit(1);
});
