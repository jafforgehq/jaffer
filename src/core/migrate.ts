import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertJafferHome } from './reset';
import { firstDayBlockFiles, removeClaudeBlock, removeJafferSkills } from './integrations/legacy-claude';
import { removeLegacyAgent } from './service/legacy-agent';
import { isDefaultHome } from './session/caffeinate';
import { VERSION } from './version';
import { pruneDeadKeys } from '../shared/config';
import { readJson, writeJson } from '../shared/util';

/**
 * The first start of 0.6.0 on a Mac an older Jaffer ran on. Jaffer is now a plain terminal: no memory, no saved session, no login agent.
 * What those left is taken away once, at the app's start (after an older Jaffer's background session has ended, before the app's own
 * terminal starts), and `migrated: 1` in `config.json` says it is done. The steps, in the order they run:
 *
 * - `agent`: the login agent of 0.5 (`removeLegacyAgent`: its plist, its wrapper, its job in launchd; `launchctl` gets 20 s at most).
 * - `backup`: the two files of the memory the person wrote, `memory/NOTES.md` and `memory/POLICY.md`, are copied to
 *   `~/.jaffer-memory-backup/` (a private folder; an earlier copy is never overwritten), when they hold anything of the person's.
 * - `oldData`: `memory/`, `session/` and `bin/jafferd` are deleted. The memory only once the backup is made.
 * - `claudeMd`, `skills`, `firstDayBlocks`, `mcp`: what the memory wrote into Claude Code (only Jaffer's own entries): the marked block in
 *   `~/.claude/CLAUDE.md` (and, from the first builds, in `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`), the `jaffer-*` skills that
 *   carry Jaffer's marker, and the user-scope MCP server `jaffer` (`claude mcp remove jaffer -s user`, last: it can take seconds).
 *   Claude Code's hooks are not touched here: the terminal rewrites Jaffer's own at its start.
 * - `config` (just before `mcp`): the settings 0.6.0 no longer has are pruned (`DEAD_KEYS`) and the marker is set, whatever the steps
 *   before did: a step that failed is not retried at every start (it is in `migrate.log`; Reset still cleans up). A first start that is
 *   ended before it (the app quit or killed while `launchctl` is asked) has not set it, and the next start runs it all again: every step
 *   is safe to repeat. Every wait before it is bounded (20 s), inside the 30 s the app gives the whole, so the terminal (which starts after
 *   it) loads the pruned settings with the marker.
 *
 * Safety. Every step is on its own: one that fails is recorded (`failed`, and a line in `<home>/migrate.log` with the step's name and an
 * error code, nothing else) and the others still run. It never throws. Nothing is removed from a folder that is not clearly Jaffer's
 * (`assertJafferHome`: then nothing at all is done), and nothing is removed through a link: a link is removed, never what it points at.
 * What lies outside Jaffer's folder (the login agent, Claude Code's files, the MCP server) is touched only for the person's own
 * `~/.jaffer` (`isDefaultHome`): a smoke test or a dev build with another home leaves the person's Claude Code alone. A fresh install (no
 * Jaffer folder yet) has nothing an older Jaffer registered: no `claude` is run for it.
 */

/** The steps, in the order they run (`migrate.log` lists them so). */
export const MIGRATION_STEPS = ['agent', 'backup', 'oldData', 'claudeMd', 'skills', 'firstDayBlocks', 'config', 'mcp'] as const;
export type StepResult = 'done' | 'skipped' | 'failed';

export interface MigrateOptions {
  /** Jaffer's folder (`~/.jaffer`, or `JAFFER_HOME`). */
  home: string;
  /** The person's home folder: the login agent's plist, Claude Code's files and the backup folder are under it. */
  userHome: string;
  /** The person's uid, for launchd's domain (`gui/<uid>`). */
  uid: number;
  /** The `claude` to run `claude mcp remove jaffer -s user` with. Left out: `findClaude` is asked. Neither: that step is skipped. */
  claudeBin?: string;
  /** Looks for `claude` (it can take seconds: a login shell). Asked only when that step is due: never once the migration has run. */
  findClaude?: () => Promise<string | null>;
  /** Runs a program and says how it ended (0: done). Left out: `execFile`, stopped at the timeout. Tests pass a stand-in. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number }>;
  /** launchd, for the login agent (`removeLegacyAgent`). Left out: the real `launchctl`. Tests pass a fake. */
  launchctl?: (args: string[]) => Promise<{ code: number }>;
  /** How long `claude mcp remove` may take (default 10 s). */
  mcpTimeoutMs?: number;
  now?: () => Date;
}

/**
 * The text every older version (0.1 to 0.5.1) put in `memory/POLICY.md` when it first started. A POLICY.md that is still exactly this is
 * not the person's: it is not backed up (only what the person wrote is).
 */
export const OLD_DEFAULT_POLICY = `# Memory policy

Jaffer keeps ONE continuous session with you and learns from it. These rules steer what it remembers.
Edit this file freely — it is yours and is never rewritten automatically.

## Remember
- Stable preferences (tools, style, workflow, communication).
- Conventions and facts about the projects you work in (how to build/test, layout, constraints).
- Mistakes that cost time and the fix that worked.
- Procedures you repeat.

## Never remember
- Secrets, tokens, passwords, keys, private personal data.
- One-off, transient state (a particular error from today, a temporary file path).
- Anything you tell Jaffer to forget.
`;

/** Where the two hand-written files of the memory are copied, in the person's home folder. */
export const BACKUP_DIR = '.jaffer-memory-backup';
const MCP_TIMEOUT_MS = 10_000;

/** A failure with the reason the log gives (a code or a few words, never a path). */
class Failed extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const codeOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' || typeof c === 'number' ? String(c) : undefined;
};
/** What the log says of a failure: its reason, or the error's code (EACCES, ENOENT, ...), or its kind. Never its message (paths). */
const whyOf = (e: unknown): string => (e instanceof Failed ? e.why : (codeOf(e) ?? (e instanceof Error ? e.name : 'error')));
const lstat = (p: string): fs.Stats | undefined => fs.lstatSync(p, { throwIfNoEntry: false });

export async function migrateToPlainTerminal(o: MigrateOptions): Promise<{ steps: Record<string, StepResult> }> {
  const steps: Record<string, StepResult> = Object.fromEntries(MIGRATION_STEPS.map((s) => [s, 'skipped']));
  const problems: string[] = [];
  let home: string;
  try {
    const configFile = path.join(o.home, 'config.json');
    if (alreadyMigrated(configFile)) return { steps };
    home = assertJafferHome(o.home, o.userHome);
  } catch (e) {
    console.error(`jaffer: the first start's clean-up did not run: ${e instanceof Error ? e.message : String(e)}`);
    return { steps: { home: 'failed', ...steps } };
  }

  const step = async (name: (typeof MIGRATION_STEPS)[number], fn: () => StepResult | Promise<StepResult>): Promise<void> => {
    try {
      steps[name] = await fn();
    } catch (e) {
      steps[name] = 'failed';
      problems.push(`${name} failed: ${whyOf(e)}`);
    }
  };
  // What lies outside Jaffer's folder is the person's own Jaffer's to clean up: not a smoke test's or a dev build's.
  let mine = false;
  try {
    mine = isDefaultHome(home);
  } catch {
    /* not the person's own */
  }
  // An older Jaffer ran here when its folder holds anything (a fresh install has no folder yet: the app has not written any; a first start
  // that was ended early has left only its log).
  let older = false;
  try {
    older = fs.readdirSync(home).some((e) => e !== 'migrate.log');
  } catch {
    /* no folder: a fresh install */
  }
  const logLines = (...lines: string[]) => {
    try {
      const at = (o.now?.() ?? new Date()).toISOString();
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(home, 'migrate.log'), lines.map((l) => `${at} ${l}\n`).join(''), { mode: 0o600 });
    } catch {
      /* the log is only for diagnosis */
    }
  };
  // first a trace, so that a start that is ended before the clean-up is done leaves one
  logLines(`Jaffer ${VERSION}: one-time clean-up started (${older ? 'an older Jaffer folder' : 'no older Jaffer folder'})`);

  await step('agent', async () => {
    if (!mine) return 'skipped';
    let failure: unknown;
    await removeLegacyAgent({ home, userHome: o.userHome, uid: o.uid, launchctl: o.launchctl, onError: (e) => (failure ??= e) });
    if (failure !== undefined) throw failure;
    return 'done';
  });

  await step('backup', () => {
    const names = notesWorthKeeping(home);
    if (!names.length) return 'skipped';
    backUp(home, o.userHome, names);
    return 'done';
  });

  await step('oldData', () => {
    const keepMemory = steps.backup === 'failed';
    let removed = false;
    const why: string[] = [];
    if (keepMemory && lstat(path.join(home, 'memory'))) why.push('memory kept (its backup failed)');
    for (const rel of [...(keepMemory ? [] : [['memory']]), ['session'], ['bin', 'jafferd']]) {
      try {
        if (removeInside(home, rel)) removed = true;
      } catch (e) {
        why.push(whyOf(e));
      }
    }
    if (why.length) throw new Failed(why.join('; '));
    return removed ? 'done' : 'skipped';
  });

  await step('claudeMd', () => {
    if (!mine) return 'skipped';
    removeBlock(path.join(o.userHome, '.claude', 'CLAUDE.md'));
    return 'done';
  });

  await step('skills', () => {
    if (!mine) return 'skipped';
    removeJafferSkills(path.join(o.userHome, '.claude', 'skills'));
    return 'done';
  });

  await step('firstDayBlocks', () => {
    if (!mine) return 'skipped';
    let failure: unknown;
    for (const file of firstDayBlockFiles(o.userHome)) {
      try {
        removeBlock(file);
      } catch (e) {
        failure ??= e;
      }
    }
    if (failure !== undefined) throw failure;
    return 'done';
  });

  await step('config', () => {
    writeMarker(path.join(home, 'config.json'));
    return 'done';
  });

  await step('mcp', async () => {
    if (!mine || !older) return 'skipped';
    const claude = o.claudeBin ?? (await o.findClaude?.()) ?? null;
    if (!claude) return 'skipped';
    const r = await runBounded(claude, ['mcp', 'remove', 'jaffer', '-s', 'user'], o.run, o.mcpTimeoutMs ?? MCP_TIMEOUT_MS);
    if (r === 'timeout') throw new Failed('timeout');
    if (r.code !== 0) throw new Failed(`exit ${r.code} (no MCP server named jaffer was registered, or claude failed)`);
    return 'done';
  });

  const summary = MIGRATION_STEPS.map((s) => `${s} ${steps[s]}`).join(', ');
  logLines(older ? `Jaffer ${VERSION}: clean-up after an older version: ${summary}` : `Jaffer ${VERSION}: first start, no older Jaffer folder: ${summary}`, ...problems);
  return { steps };
}

/** `migrated` is 1 (or more) in `config.json`: the clean-up has run. */
function alreadyMigrated(configFile: string): boolean {
  const cfg = readJson<unknown>(configFile, null);
  return isRecord(cfg) && typeof cfg.migrated === 'number' && cfg.migrated >= 1;
}

/**
 * `config.json` without the settings 0.6.0 no longer has, and with `migrated: 1`. Everything else (the person's settings, keys a newer
 * version wrote) stays as it was. A file that cannot be read as settings is kept aside (`config.json.unreadable`), not overwritten.
 */
function writeMarker(file: string): void {
  let cfg: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (codeOf(e) !== 'ENOENT') keepAside(file);
  }
  if (raw !== undefined && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) cfg = parsed;
    else keepAside(file);
  }
  writeJson(file, { ...pruneDeadKeys(cfg), migrated: 1 });
}

function keepAside(file: string): void {
  let to = `${file}.unreadable`;
  for (let n = 2; lstat(to); n++) to = `${file}.unreadable-${n}`;
  fs.renameSync(file, to);
}

/**
 * Which of the memory's two hand-written files hold anything of the person's: a regular file (not a link: what it points at is not
 * Jaffer's to read), not empty or blank, and for POLICY.md not the text every older version put there. In a `memory` that is a folder.
 */
function notesWorthKeeping(home: string): string[] {
  const memory = path.join(home, 'memory');
  const st = lstat(memory);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
  const out: string[] = [];
  for (const name of ['NOTES.md', 'POLICY.md']) {
    const file = path.join(memory, name);
    const s = lstat(file);
    if (!s?.isFile() || s.size === 0) continue;
    if (s.size <= 1 << 20) {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim() || (name === 'POLICY.md' && text === OLD_DEFAULT_POLICY)) continue;
    }
    out.push(name);
  }
  return out;
}

/** Copies `memory/<name>` for each name to `<userHome>/.jaffer-memory-backup/` (0700): never over a file there (`NOTES-2.md`, ...). */
function backUp(home: string, userHome: string, names: string[]): void {
  const dir = path.join(userHome, BACKUP_DIR);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (codeOf(e) !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Failed('the backup folder is not a folder');
  for (const name of names) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const to = path.join(dir, n === 1 ? name : `${base}-${n}${ext}`);
      try {
        fs.copyFileSync(path.join(home, 'memory', name), to, fs.constants.COPYFILE_EXCL); // (never over a file or a link that is there)
        fs.chmodSync(to, 0o600);
        break;
      } catch (e) {
        if (codeOf(e) !== 'EEXIST' || n >= 999) throw e;
      }
    }
  }
}

/**
 * Removes `<home>/<rel...>`: a folder with everything in it (a link inside is removed, never followed), a file, or a link (never what it
 * points at). A folder on the way that is a link (out of Jaffer's folder) is refused. False when there was nothing.
 */
function removeInside(home: string, rel: string[]): boolean {
  let dir = home;
  for (const part of rel.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = lstat(dir);
    if (!st) return false;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Failed(`${rel.join('/')}: a link or a file on the way`);
  }
  const target = path.join(dir, rel[rel.length - 1]!);
  const st = lstat(target);
  if (!st) return false;
  if (st.isDirectory()) fs.rmSync(target, { recursive: true });
  else fs.unlinkSync(target);
  return true;
}

/** `removeClaudeBlock`, with a file that is there but cannot be read told as a failure (it says nothing of one). */
function removeBlock(file: string): void {
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return; // not there: nothing to do
    throw e;
  }
  removeClaudeBlock(file);
}

/** Runs `cmd args` (with `run`, or `execFile`), and gives up at `timeoutMs` (the program `execFile` ran is killed). */
async function runBounded(cmd: string, args: string[], run: MigrateOptions['run'], timeoutMs: number): Promise<{ code: number } | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), run ? timeoutMs : timeoutMs + 1_000);
    timer.unref?.();
  });
  try {
    return await Promise.race([run ? run(cmd, args) : execRun(cmd, args, timeoutMs), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `cmd args` through `execFile`, killed at `timeoutMs`. `cmd`'s own folder comes first on the PATH it gets: a `claude` installed with npm
 * is a script that starts `node` from the PATH, and an app opened from the Finder has a short one (the `node` next to it is the right one).
 */
function execRun(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number } | 'timeout'> {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, PATH: [path.dirname(cmd), process.env.PATH].filter(Boolean).join(path.delimiter) };
      execFile(cmd, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err) => {
        if (!err) return resolve({ code: 0 });
        if ((err as { killed?: boolean }).killed) return resolve('timeout');
        const code = (err as { code?: unknown }).code;
        resolve({ code: typeof code === 'number' && code !== 0 ? code : 1 });
      });
    } catch {
      resolve({ code: 1 });
    }
  });
}
