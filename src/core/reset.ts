import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teardownClaude } from './integrations/claude';
import { applyBlock, removeClaudeSkills, targetDefs } from './memory/exports';
import { agentPaths, bootoutNote, execLaunchctl, LaunchAgent, REFUSED_NOT_MAC, REFUSED_OTHER_HOME, type AgentStatus, type Launchctl } from './service/launch-agent';
import { isDefaultHome } from './session/caffeinate';
import { ConfigStore } from '../shared/config';
import { APP_BUNDLE_ID } from '../shared/keep-running';
import { makePaths } from '../shared/paths';

export interface ResetOptions {
  /** Jaffer's own folder (default ~/.jaffer). */
  home: string;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Move Jaffer's folder aside as `<home>.backup-<time>` instead of deleting it. */
  backup: boolean;
  /** Also remove the app's own data (Electron's folder, preferences, saved window state). The running app clears its own. */
  appData?: boolean;
  now?: Date;
  /**
   * launchd, for the login agent that keeps the session running. Left out: the real `launchctl`, and only for the person's own
   * `~/.jaffer` on macOS (`isDefaultHome`): a reset of any other home (a test, a second install) never touches launchd or the agent's
   * plist. `null`: leave the agent alone. Tests pass a fake.
   */
  launchctl?: Launchctl | null;
  /** The user whose launchd domain (`gui/<uid>`) holds the agent (default: this process's). */
  uid?: number;
  /**
   * Tells a daemon that still runs that the switch is off (`config.patch`: its config lives in memory, and it would write it back). The
   * config file is set to off as well, whatever this does. Left out: no daemon runs.
   */
  keepRunningOff?: () => Promise<void>;
  /**
   * Ends the session (the daemon owns Jaffer's folder; when this returns it must be stopped). Called once the switch is off and the agent
   * is gone, before anything else is removed. Left out: the caller has ended it already.
   */
  endSession?: () => Promise<void>;
}

export interface ResetResult {
  backupDir?: string;
  messages: string[];
}

const BUNDLE_ID = APP_BUNDLE_ID;

/** What Jaffer keeps in its folder: a folder that is neither empty nor holds at least one of these is not Jaffer's. */
const OWN_ENTRIES = ['config.json', 'memory', 'run', 'session', 'shell', 'bin'];

/**
 * Only ever remove a folder that is clearly Jaffer's: never the home folder or a parent of it, never something without "jaffer"
 * in its name, never a code checkout (a `.git` or `package.json` in it), and a folder that exists must hold Jaffer's own files
 * (or nothing at all). JAFFER_HOME pointed at the wrong place must not cost anyone a project.
 */
function assertJafferHome(home: string, userHome: string): string {
  const h = path.resolve(home);
  const u = path.resolve(userHome);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
  const refuse = () => new Error(`Refusing to reset ${h}: it is not clearly Jaffer's own folder.`);
  if (h === path.parse(h).root || inside(h, u) || path.dirname(h) === path.parse(h).root || !/jaffer/i.test(path.basename(h))) throw refuse();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(h);
  } catch {
    return h; // not there: nothing to remove
  }
  if (entries.includes('.git') || entries.includes('package.json')) throw refuse();
  if (entries.length > 0 && !entries.some((e) => OWN_ENTRIES.includes(e))) throw refuse();
  return h;
}

const stamp = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function rm(p: string): boolean {
  if (!fs.existsSync(p) && !isLink(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}
function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The switch "Keep my session running in the background" off in Jaffer's config file, so that a daemon that starts while the reset runs
 * (an open app reconnecting) does not put the agent back. Only a config that is there is written: a reset makes no folder. A config
 * that cannot be written (a full disk) stops nothing: what comes next (the agent away, the session ended) matters more.
 */
function keepRunningOffOnDisk(home: string): void {
  try {
    const paths = makePaths(home);
    if (!fs.existsSync(paths.config)) return;
    const config = new ConfigStore(paths);
    if (config.get().session.keepRunning) config.patch({ session: { keepRunning: false } });
  } catch {
    /* carry on */
  }
}

/**
 * Take away the login agent that keeps the session running: its plist (in the person's LaunchAgents), its wrapper (`<home>/bin/jafferd`)
 * and the job in launchd (`bootout`; when launchd runs the daemon, that ends it, after it saved the state, and launchd does not start it
 * again). A step of `resetJaffer`, after the switch is off and before the session ends; silent when it was done already. Nothing at all
 * without an agent on disk. Returns what to tell the person, with what launchd answered.
 */
export async function removeAgentForReset(o: Pick<ResetOptions, 'home' | 'userHome' | 'launchctl' | 'uid'>): Promise<string[]> {
  const home = path.resolve(o.home);
  const launchctl = o.launchctl !== undefined ? o.launchctl : process.platform === 'darwin' && isDefaultHome(home) ? execLaunchctl() : null;
  if (!launchctl) return [];
  const files = agentPaths({ home, userHome: o.userHome ?? os.homedir() });
  if (!fs.existsSync(files.plistPath) && !fs.existsSync(files.wrapperPath)) return [];
  const agent = new LaunchAgent({ launchctl, uid: o.uid ?? process.getuid?.() ?? -1, fs });
  const r = await agent.remove(files);
  return [`Removed the background agent that kept the session running (${files.plistPath.replace(o.userHome ?? os.homedir(), '~')}); ${bootoutNote(r)}`];
}

/**
 * `jaffer service remove` when no daemon answers (none runs, or one that cannot start crash-loops under launchd, and Settings needs a
 * daemon too): the switch off in the config file first, so a daemon that starts later does not put the agent back, then the agent away
 * as Reset does it. Starts nothing. A home that is not the person's own (or not a Mac) is refused and nothing is touched, not even the
 * switch, as the daemon's `service.remove` does it.
 */
export async function removeAgentWithoutDaemon(o: Pick<ResetOptions, 'home' | 'userHome' | 'launchctl' | 'uid'>): Promise<{ status: AgentStatus; messages: string[] }> {
  const home = path.resolve(o.home);
  const ours = o.launchctl !== undefined ? o.launchctl !== null : process.platform === 'darwin' && isDefaultHome(home);
  if (!ours) return { status: { state: 'refused', reason: process.platform === 'darwin' ? REFUSED_OTHER_HOME : REFUSED_NOT_MAC }, messages: [] };
  keepRunningOffOnDisk(home);
  return { status: { state: 'not-installed' }, messages: await removeAgentForReset({ ...o, home }) };
}

/**
 * Take Jaffer off this Mac so the next install starts from scratch: the login agent that keeps the session running (first), its hooks and memory tools in Claude Code, what it wrote
 * into Claude's files, the `jaffer` command link, the update cache, its own folder (moved aside as a backup unless `backup` is
 * false) and, optionally, the app's own data. Claude Code itself, its login and the person's own settings are not touched.
 * The order: the switch off, the login agent away, the session ended (`endSession`; without it the daemon must already be stopped, as it
 * owns the folder), then the rest.
 */
export async function resetJaffer(o: ResetOptions): Promise<ResetResult> {
  const userHome = o.userHome ?? os.homedir();
  const home = assertJafferHome(o.home, userHome);
  const env = o.env ?? process.env;
  const messages: string[] = [];
  let changed = false;
  const did = (m: string) => {
    changed = true;
    messages.push(m);
  };

  // First, in this order, while Jaffer's folder is still there: the switch off (in a daemon that runs, and in the file), so nothing
  // started meanwhile puts the agent back (when launchd runs the daemon, that patch itself ends it: the daemon takes the agent away
  // about 50 ms after its reply); the agent away, so launchd starts nothing for a session being reset (a duplicate of what the daemon
  // did, and the only thing that does it when none answered); then the session ends; then the rest.
  await o.keepRunningOff?.().catch(() => undefined);
  keepRunningOffOnDisk(home);
  for (const m of await removeAgentForReset({ home, userHome, launchctl: o.launchctl, uid: o.uid })) did(m);
  await o.endSession?.();

  const td = await teardownClaude(userHome, env);
  if (td.messages.some((m) => /^Removed/.test(m))) changed = true;
  messages.push(...td.messages);

  for (const def of Object.values(targetDefs(userHome))) if (applyBlock(def.file, null) === 'removed') did(`Removed Jaffer's memory block from ${def.file.replace(userHome, '~')}.`);
  const skills = removeClaudeSkills(userHome);
  if (skills) did(`Removed ${skills} skill${skills === 1 ? '' : 's'} Jaffer had published to Claude Code.`);

  const link = path.join(userHome, '.local', 'bin', 'jaffer');
  if (isLink(link) && path.resolve(path.dirname(link), fs.readlinkSync(link)).startsWith(home + path.sep)) {
    fs.rmSync(link, { force: true });
    did('Removed the `jaffer` command from ~/.local/bin.');
  }

  const library = path.join(userHome, 'Library');
  if (rm(path.join(library, 'Caches', 'jaffer-updater'))) did('Removed the update cache.');
  if (o.appData !== false) {
    const gone: boolean[] = [
      rm(path.join(library, 'Application Support', 'Jaffer')),
      rm(path.join(library, 'Preferences', `${BUNDLE_ID}.plist`)),
      rm(path.join(library, 'Saved Application State', `${BUNDLE_ID}.savedState`)),
      rm(path.join(library, 'Logs', 'Jaffer')),
    ];
    try {
      for (const n of fs.readdirSync(path.join(library, 'Caches'))) if (n.startsWith(BUNDLE_ID)) gone.push(rm(path.join(library, 'Caches', n)));
    } catch {
      /* no caches folder */
    }
    if (gone.some(Boolean)) did("Removed the app's own data (settings, window state, caches).");
  }

  let backupDir: string | undefined;
  if (fs.existsSync(home)) {
    if (o.backup) {
      const base = `${home}.backup-${stamp(o.now ?? new Date())}`;
      backupDir = base;
      for (let n = 2; fs.existsSync(backupDir); n++) backupDir = `${base}-${n}`;
      fs.renameSync(home, backupDir);
      did(`Moved ${home.replace(userHome, '~')} to ${backupDir.replace(userHome, '~')} (a backup: delete it when you are sure).`);
    } else {
      fs.rmSync(home, { recursive: true, force: true });
      did(`Deleted ${home.replace(userHome, '~')}.`);
    }
  }

  if (!changed) messages.push('Nothing to reset: Jaffer has not left anything on this Mac.');
  return { backupDir, messages };
}
