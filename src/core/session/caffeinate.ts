import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StayAwakeDeps } from './stay-awake';

/**
 * The real hold behind `StayAwake`, kept apart from it so it is easy to see everything that can touch the Mac: `/usr/bin/caffeinate`, run
 * with the arguments the controller gives (`-i -w <daemon pid>`: no idle sleep, and it ends by itself if the daemon does), killed to let go.
 */
export const CAFFEINATE = '/usr/bin/caffeinate';

/**
 * Is this the home of the person's own Jaffer: `~/.jaffer` in the real home folder of the user running it? A daemon of any other home (a
 * test, a second install) never holds the Mac awake. The folder is compared as `makePaths` makes it, and the home folder must also be the
 * one the system has for the user, so a `HOME` pointed at a temporary folder is not the person's.
 */
export function isDefaultHome(home: string): boolean {
  try {
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const mine = os.homedir();
    return real(home) === real(path.join(mine, '.jaffer')) && real(mine) === real(os.userInfo().homedir);
  } catch {
    return false;
  }
}

/**
 * What the daemon gives `StayAwake` as `platform` and `hold`:
 * - `JAFFER_TEST_HOLD_LOG=<file>` (tests): nothing is run; every hold and release is appended to the file as a line of JSON,
 *   `{"op":"hold"|"release","args":[...]}`. It stands in for macOS, so that the daemon can be tested anywhere without a real hold.
 * - a home that is not the default one: no platform, so nothing is ever held.
 * - otherwise `/usr/bin/caffeinate`, and letting go kills it.
 */
export function caffeinateHold(home: string, env: NodeJS.ProcessEnv = process.env): Pick<StayAwakeDeps, 'platform' | 'hold'> {
  const logFile = env.JAFFER_TEST_HOLD_LOG;
  if (logFile) {
    const note = (op: 'hold' | 'release', args: string[]) => fs.appendFileSync(logFile, `${JSON.stringify({ op, args })}\n`);
    return {
      platform: 'darwin',
      hold: (args) => {
        note('hold', args);
        return { release: () => note('release', args) };
      },
    };
  }
  if (!isDefaultHome(home)) return { platform: 'not-the-default-home', hold: () => ({ release: () => undefined }) };
  return {
    platform: process.platform,
    hold: (args) => {
      const child = execFile(CAFFEINATE, args, () => undefined); // (its end, or its failure to start, is no news: the next hold starts another)
      child.unref();
      return { release: () => void child.kill() };
    },
  };
}
