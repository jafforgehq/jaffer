import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude, removeMcp, teardownClaude } from './integrations/claude';
import { removeClaudeBlock, removeJafferSkills } from './integrations/legacy-claude';
import { AGENT_LABEL, removeLegacyAgent } from './service/legacy-agent';
import { APP_BUNDLE_ID } from '../shared/stay-awake-config';

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
   * launchd, for the login agent an older Jaffer may have left (`removeLegacyAgent`, which touches launchd and the agent's plist only
   * for the person's own `~/.jaffer`: a reset of any other home, a test or a second install, leaves them alone). Left out: the real
   * `launchctl`. Tests pass a fake.
   */
  launchctl?: (args: string[]) => Promise<{ code: number }>;
  /** The user whose launchd domain (`gui/<uid>`) holds the agent (default: this process's). */
  uid?: number;
  /**
   * Ends the session (the daemon owns Jaffer's folder; when this returns it must be stopped). Called once the login agent of an older
   * Jaffer is gone, before anything else is removed. Left out: the caller has ended it already.
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
 * Take Jaffer off this Mac so the next install starts from scratch: the login agent an older Jaffer left (first), its hooks in
 * Claude Code and what its memory left there before 0.6.0 (an MCP server, a block in CLAUDE.md, published skills), the `jaffer` command
 * link, the update cache, its own folder (moved aside as a backup unless `backup` is false) and, optionally, the app's own data. Claude
 * Code itself, its login and the person's own settings are not touched.
 * The order: the login agent away, the session ended (`endSession`; without it the daemon must already be stopped, as it owns the
 * folder), then the rest.
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

  // First, in this order, while Jaffer's folder is still there: the login agent of an older Jaffer away, so launchd starts nothing for
  // a session being reset (when launchd runs the daemon, that ends it); then the session ends; then the rest.
  const agent = await removeLegacyAgent({ home, userHome, uid: o.uid ?? process.getuid?.() ?? -1, launchctl: o.launchctl });
  if (agent.removed) did(`Removed the background agent that kept the session running (~/Library/LaunchAgents/${AGENT_LABEL}.plist).`);
  await o.endSession?.();

  const td = await teardownClaude(userHome, env);
  if (td.messages.some((m) => /^Removed/.test(m))) changed = true;
  messages.push(...td.messages);

  // what Jaffer's memory left in Claude Code before 0.6.0 (only Jaffer's own entries): the MCP server, the block, the skills
  const claude = await findClaude(env);
  if (claude && (await removeMcp(claude, env)).ok) did('Removed the MCP server registration.');
  const claudeMd = path.join(userHome, '.claude', 'CLAUDE.md');
  if (removeClaudeBlock(claudeMd)) did(`Removed Jaffer's memory block from ${claudeMd.replace(userHome, '~')}.`);
  const skills = removeJafferSkills(path.join(userHome, '.claude', 'skills'));
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
