import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDefaultHome } from '../session/caffeinate';

/**
 * Jaffer 0.5 could keep the session running through a login agent: a launchd job (`~/Library/LaunchAgents/com.jafforge.jaffer.daemon.plist`)
 * that ran a wrapper (`~/.jaffer/bin/jafferd`) and started the daemon at login and after a crash. Jaffer no longer has one, and an agent
 * that is left behind is harmful: with the app gone from where its wrapper points, launchd would start nothing, and fail again every five
 * seconds. This is the one thing that still knows about it: it takes it away from a Mac that has one (Reset, and the first start of a
 * Jaffer that finds an older one).
 */

/** The launchd label of that login agent. */
export const AGENT_LABEL = 'com.jafforge.jaffer.daemon';

/** Runs `launchctl <args>` and says how it ended (0: done). It never rejects when it is the real one. */
type Launchctl = (args: string[]) => Promise<{ code: number }>;

/** The real `launchctl`: macOS only, and a failed run, or one that could not start, is a code that is not 0 (it never rejects). */
function realLaunchctl(args: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ code: 1 });
    try {
      execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1 << 20 }, (err) => {
        if (!err) return resolve({ code: 0 });
        const code = (err as NodeJS.ErrnoException).code;
        resolve({ code: typeof code === 'number' && code !== 0 ? code : 1 });
      });
    } catch {
      resolve({ code: 1 });
    }
  });
}

/** Is there anything at `file`, a link included (a link that points nowhere is still the agent's file to take away)? */
function there(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Take the login agent of an older Jaffer away: its plist, its wrapper and its job in launchd. Only for the person's own `~/.jaffer`
 * (`isDefaultHome(home)`): a test home or a second install has no agent and nothing here touches it. The files go first, the plist
 * before the wrapper (so launchd never starts a job with no wrapper), and `launchctl bootout gui/<uid>/com.jafforge.jaffer.daemon` last,
 * because when launchd runs the daemon, the bootout ends it (and whatever asked for it from inside that session). A job launchd does
 * not know is fine. `JAFFER_NO_LAUNCHCTL=1` (set for every test run) skips the `launchctl` call, the one given as well; the files still
 * go. It never throws: a failure (a file that cannot be removed, a `launchctl` that cannot run) is logged and gives `removed: false`,
 * and the rest is still done. `removed` is true when something of the agent was taken away (a file, or a job launchd had loaded) and
 * nothing failed.
 */
export async function removeLegacyAgent(opts: { home: string; userHome: string; uid: number; launchctl?: Launchctl }): Promise<{ removed: boolean }> {
  try {
    if (!isDefaultHome(opts.home)) return { removed: false };
    let failed = false;
    let found = false;
    const fail = (what: string, e: unknown) => {
      failed = true;
      console.error(`jaffer: could not ${what}: ${e instanceof Error ? e.message : String(e)}`);
    };

    const plist = path.join(opts.userHome, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
    const wrapper = path.join(opts.home, 'bin', 'jafferd');
    for (const file of [plist, wrapper]) {
      try {
        if (!there(file)) continue;
        fs.rmSync(file, { force: true }); // (a link is removed, never what it points at; a folder in its place is refused)
        found = true;
      } catch (e) {
        fail(`remove ${file}`, e);
      }
    }

    if (process.env.JAFFER_NO_LAUNCHCTL !== '1' && Number.isInteger(opts.uid) && opts.uid >= 0) {
      try {
        const r = await (opts.launchctl ?? realLaunchctl)(['bootout', `gui/${opts.uid}/${AGENT_LABEL}`]);
        if (r.code === 0) found = true; // (3 and 113: launchd had no such job, which is the usual case and not news)
      } catch (e) {
        fail('boot the login agent out of launchd', e);
      }
    }
    return { removed: found && !failed };
  } catch (e) {
    console.error(`jaffer: could not remove the old login agent: ${e instanceof Error ? e.message : String(e)}`);
    return { removed: false };
  }
}
