import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { migrateToPlainTerminal, MIGRATION_STEPS, OLD_DEFAULT_POLICY, type MigrateOptions } from '../src/core/migrate';
import { prepareHome } from '../src/main/prepare-home';
import { BEGIN, END, SKILL_MARKER } from '../src/core/integrations/legacy-claude';
import { AGENT_LABEL } from '../src/core/service/legacy-agent';
import { makePaths } from '../src/shared/paths';

/**
 * The first start of 0.6.0 on a Mac an older Jaffer ran on (`migrateToPlainTerminal`). For real it deletes data, runs `launchctl bootout`
 * and `claude mcp remove`, and edits files in `~/.claude`, so everything here runs against two temporary folders (Jaffer's own and a
 * stand-in for the person's home) with stand-ins for the rest:
 * - `isDefaultHome` says yes only to the temporary homes a test names (`asDefaultHome`), and otherwise answers as the real one does (a
 *   temporary home is never the person's own `~/.jaffer`);
 * - `launchctl` is a fake that records its calls;
 * - `claude` is a small script in the test's folder that records its arguments;
 * - `execFile`, through which the migration runs programs it is not handed, is a fake that runs only programs inside the test's own
 *   folder and refuses anything else (the real `/bin/launchctl`, a real `claude`): a test that forgets to hand a stand-in over cannot
 *   reach the real one.
 */
const { forcedHomes, execFileMock, real } = vi.hoisted(() => ({
  forcedHomes: new Set<string>(),
  execFileMock: vi.fn(),
  real: { execFile: null as unknown as typeof import('node:child_process').execFile, root: '', refused: [] as string[] },
}));
vi.mock('../src/core/session/caffeinate', async (orig) => {
  const actual = await orig<typeof import('../src/core/session/caffeinate')>();
  return { ...actual, isDefaultHome: (home: string) => forcedHomes.has(home) || actual.isDefaultHome(home) };
});
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  real.execFile = actual.execFile;
  return { ...actual, execFile: execFileMock };
});

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  forcedHomes.clear();
  real.root = env.root;
  real.refused = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation((file: string, args: string[], opts: object, cb: (e: Error | null, out: string, err: string) => void) => {
    if (typeof file === 'string' && file.startsWith(real.root + path.sep)) return real.execFile(file, args, opts, cb);
    real.refused.push(file);
    setImmediate(() => cb(Object.assign(new Error(`not run by a test: ${file}`), { code: 1 }), '', ''));
    return { kill: () => true };
  });
  vi.stubEnv('JAFFER_NO_LAUNCHCTL', ''); // (the run sets it: the fake launchctl must be reachable; the fake execFile keeps the real one out)
});
afterEach(() => {
  vi.unstubAllEnvs();
  env.cleanup();
});

const mk = (p: string, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const read = (p: string) => fs.readFileSync(p, 'utf8');
const gone = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined;
const asDefaultHome = () => forcedHomes.add(env.home);
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

function fakeLaunchctl(answer: { code: number } | 'throw' = { code: 0 }) {
  const calls: string[][] = [];
  const launchctl = async (args: string[]): Promise<{ code: number }> => {
    calls.push(args);
    if (answer === 'throw') throw new Error('launchctl exploded');
    return answer;
  };
  return { launchctl, calls };
}

/** A stand-in `claude` in the test's folder: it records its arguments, then exits with `code` (or hangs). */
function fakeClaude(how: { code: number } | 'hang' = { code: 0 }): { bin: string; calls: () => string[]; pidFile: string } {
  const dir = path.join(env.root, 'fake-bin');
  const bin = path.join(dir, 'claude');
  const log = path.join(env.root, 'claude-calls.log');
  const pidFile = path.join(env.root, 'claude.pid');
  const tail = how === 'hang' ? `echo $$ > '${pidFile}'\nexec /bin/sleep 30\n` : `exit ${how.code}\n`;
  mk(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${tail}`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? read(log).split('\n').filter(Boolean) : []), pidFile };
}

const P = {
  plist: () => path.join(env.userHome, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
  otherPlist: () => path.join(env.userHome, 'Library', 'LaunchAgents', 'com.example.other.plist'),
  claudeMd: () => path.join(env.userHome, '.claude', 'CLAUDE.md'),
  settings: () => path.join(env.userHome, '.claude', 'settings.json'),
  skill: (name: string) => path.join(env.userHome, '.claude', 'skills', name, 'SKILL.md'),
  codex: () => path.join(env.userHome, '.codex', 'AGENTS.md'),
  gemini: () => path.join(env.userHome, '.gemini', 'GEMINI.md'),
  backup: (name = '') => path.join(env.userHome, '.jaffer-memory-backup', name),
  config: () => path.join(env.home, 'config.json'),
  log: () => path.join(env.home, 'migrate.log'),
};

const NOTES = '# My notes\n\nThe staging box is called kiwi.\n';
const POLICY = `${OLD_DEFAULT_POLICY}\n## Mine\n- Remember which client a folder belongs to.\n`; // edited by the person
const MY_RULES = '# My rules\n\nBe brief.\n\n';
const MY_AFTER = '\n## Later\n\nMy own text after the block.\n';
const BLOCK = `${BEGIN}\n## What Jaffer learned\n- Prefer pnpm\n${END}\n`;
/** Jaffer's live settings as an older version saved them, with every key 0.6.0 no longer has. */
const OLD_CONFIG = {
  onboarded: true,
  appearance: { theme: 'jaffer-light', fontSize: 15, companion: 'matrix' },
  claude: { skipped: true, showCost: false },
  session: { stayAwake: false, restoreScreen: false, resumeClaude: true, keepRunning: true, autoResume: true },
  hotkey: 'Alt+Space',
  memory: { enabled: true, llm: 'auto', retentionDays: 45 },
  ingest: { claudeCode: true, backfillDays: 7 },
  export: { targets: ['claude-code', 'codex'], claudeSkills: true },
  safety: { dangerTint: true, protectedBranches: ['main'] },
  future: { fromANewerVersion: 1 },
};
const SETTINGS = JSON.stringify(
  {
    theme: 'dark',
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: `'${'/x/.jaffer/bin/jaffer'}' hook stop # jaffer-managed`, timeout: 5 }] },
        { hooks: [{ type: 'command', command: 'echo my own hook' }] },
      ],
    },
  },
  null,
  2,
);

/** Everything an older Jaffer (0.5.x) leaves on a Mac, next to the person's own things. */
function upgradedMac(): void {
  // the login agent (0.5): its plist in the person's LaunchAgents, its wrapper in Jaffer's folder
  mk(P.plist(), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
  mk(P.otherPlist(), '<plist/>');
  mk(path.join(env.home, 'bin', 'jafferd'), '#!/bin/sh\nexec jafferd\n');
  mk(path.join(env.home, 'bin', 'jaffer'), '#!/bin/sh\nexec jaffer\n'); // the command the hooks run: it stays
  // the memory, with the two files the person wrote
  for (const f of ['items.jsonl', 'skills.jsonl', 'journal.jsonl', 'cursor.json', 'MEMORY.md', 'episodes/2026-10-01.jsonl', 'history/1.json', 'skills/release.md']) mk(path.join(env.home, 'memory', f), '{"text":"Prefer pnpm"}\n');
  mk(path.join(env.home, 'memory', 'NOTES.md'), NOTES);
  mk(path.join(env.home, 'memory', 'POLICY.md'), POLICY);
  // the saved session (screen.json held the screen unredacted) and the conversation Resume offered
  for (const f of ['state.json', 'screen.json', 'claude.json']) mk(path.join(env.home, 'session', f), '{}');
  // what the terminal still uses
  mk(P.config(), JSON.stringify(OLD_CONFIG, null, 2) + '\n');
  mk(path.join(env.home, 'run', 'jafferd.log'), 'log\n');
  mk(path.join(env.home, 'shell', 'jaffer.zsh'), '# zsh\n');
  mk(path.join(env.home, 'window.json'), '{"width":900,"height":600}');
  mk(path.join(env.home, 'updater.log'), 'u\n');
  // Claude Code: the person's settings and hooks (the terminal's start rewrites Jaffer's own; the migration leaves them), their CLAUDE.md
  // with Jaffer's memory block in the middle, Jaffer's published skill next to two of the person's
  mk(P.settings(), SETTINGS);
  mk(P.claudeMd(), MY_RULES + BLOCK + MY_AFTER);
  mk(P.skill('jaffer-release'), `# Release\n\n${SKILL_MARKER}\n`);
  mk(path.join(env.userHome, '.claude', 'skills', 'jaffer-release', 'notes.md'), 'x');
  mk(P.skill('jaffer-handwritten'), '# A skill of the person, whose name starts the same way\n');
  mk(P.skill('my-own-skill'));
  // the first builds (2026-10-06) also wrote the block for two other agents: one file that is only the block, one with the person's text
  mk(P.codex(), BLOCK);
  mk(path.join(env.userHome, '.codex', 'config.toml'), 'model = "x"\n');
  mk(P.gemini(), `# Gemini rules\n\n${BLOCK}`);
}

/** The person's own things, as they were before (to compare byte for byte). */
function theirs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [P.otherPlist(), P.settings(), P.skill('jaffer-handwritten'), P.skill('my-own-skill'), path.join(env.userHome, '.codex', 'config.toml'), path.join(env.home, 'bin', 'jaffer'), path.join(env.home, 'run', 'jafferd.log'), path.join(env.home, 'shell', 'jaffer.zsh'), path.join(env.home, 'window.json'), path.join(env.home, 'updater.log')]) out[f] = read(f);
  return out;
}

/** Every path under `dir` (links not followed) with what it is, its size, mtime and a digest of its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[p] = `link ${fs.readlinkSync(p)} ${st.mtimeMs}`;
      else if (st.isDirectory()) {
        out[p] = `dir ${st.mode} ${st.mtimeMs}`;
        walk(p);
      } else out[p] = `file ${st.mode} ${st.size} ${st.mtimeMs} ${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({ home: env.home, userHome: env.userHome, uid: 501, ...over });
const allDone = Object.fromEntries(MIGRATION_STEPS.map((s) => [s, 'done']));
const allSkipped = Object.fromEntries(MIGRATION_STEPS.map((s) => [s, 'skipped']));

describe('migrateToPlainTerminal: the first start of 0.6.0 on a Mac an older Jaffer ran on (temporary homes, a fake launchctl and a fake claude)', () => {
  it('takes away what an older Jaffer left: the login agent, the memory and the saved session, the agent\'s wrapper, the MCP server, the CLAUDE.md block, its skills, the first-day blocks and the settings that are gone', async () => {
    asDefaultHome();
    upgradedMac();
    const lc = fakeLaunchctl();
    const claude = fakeClaude();
    const r = await migrateToPlainTerminal(opts({ launchctl: lc.launchctl, claudeBin: claude.bin }));
    expect(r.steps).toEqual(allDone);
    // the login agent: booted out once, plist and wrapper gone
    expect(lc.calls).toEqual([['bootout', `gui/501/${AGENT_LABEL}`]]);
    expect(gone(P.plist())).toBe(true);
    expect(gone(path.join(env.home, 'bin', 'jafferd'))).toBe(true);
    // the memory and the saved session
    expect(gone(path.join(env.home, 'memory'))).toBe(true);
    expect(gone(path.join(env.home, 'session'))).toBe(true);
    // Claude Code: the MCP server, the block, Jaffer's skill (the whole folder)
    expect(claude.calls()).toEqual(['mcp remove jaffer -s user']);
    expect(read(P.claudeMd())).toBe(MY_RULES + MY_AFTER);
    expect(gone(path.join(env.userHome, '.claude', 'skills', 'jaffer-release'))).toBe(true);
    // the first-day blocks: a file that was only the block is gone, the other keeps the person's text
    expect(gone(P.codex())).toBe(true);
    expect(read(P.gemini())).toBe('# Gemini rules\n\n');
    // the settings: the keys 0.6.0 no longer has are pruned, and the marker is set
    const cfg = JSON.parse(read(P.config()));
    for (const k of ['memory', 'ingest', 'export', 'safety']) expect(cfg, k).not.toHaveProperty(k);
    for (const k of ['restoreScreen', 'resumeClaude', 'keepRunning', 'autoResume']) expect(cfg.session, k).not.toHaveProperty(k);
    expect(cfg.migrated).toBe(1);
    // and it says what it did
    expect(read(P.log())).toMatch(/config done, agent done, backup done, oldData done, claudeMd done, skills done, firstDayBlocks done, mcp done/);
  });

  it('keeps what is the person\'s, byte for byte: their text around the block, their own skills and hooks, the other agents\' files, Jaffer\'s live settings and what the terminal still uses', async () => {
    asDefaultHome();
    upgradedMac();
    const before = theirs();
    await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(theirs()).toEqual(before); // settings.json (with Jaffer's own hooks: the terminal rewrites them at its start), skills, the other plist, bin/jaffer, run, shell, window.json, updater.log
    expect(read(P.claudeMd())).toBe(MY_RULES + MY_AFTER);
    const cfg = JSON.parse(read(P.config()));
    expect(cfg).toEqual({
      onboarded: true,
      appearance: OLD_CONFIG.appearance,
      claude: { skipped: true, showCost: false }, // claude.skipped is a live setting: it stays
      session: { stayAwake: false },
      hotkey: 'Alt+Space',
      future: { fromANewerVersion: 1 }, // a key it does not know is not its to remove
      migrated: 1,
    });
    expect(fs.statSync(P.config()).mode & 0o777).toBe(0o600);
  });

  it('copies NOTES.md and POLICY.md to ~/.jaffer-memory-backup before the memory goes (a private folder), and never overwrites an earlier backup', async () => {
    asDefaultHome();
    upgradedMac();
    mk(P.backup('NOTES.md'), 'an earlier backup');
    fs.chmodSync(P.backup(), 0o700);
    await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(fs.readdirSync(P.backup()).sort()).toEqual(['NOTES-2.md', 'NOTES.md', 'POLICY.md']);
    expect(read(P.backup('NOTES.md'))).toBe('an earlier backup');
    expect(read(P.backup('NOTES-2.md'))).toBe(NOTES);
    expect(read(P.backup('POLICY.md'))).toBe(POLICY);
    for (const f of ['NOTES-2.md', 'POLICY.md']) expect(fs.statSync(P.backup(f)).mode & 0o777).toBe(0o600);
    expect(gone(path.join(env.home, 'memory'))).toBe(true);
  });

  it('creates the backup folder only for something to keep, private (0700), and holds exactly the two files', async () => {
    asDefaultHome();
    upgradedMac();
    await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(fs.readdirSync(P.backup()).sort()).toEqual(['NOTES.md', 'POLICY.md']);
    expect(fs.statSync(P.backup()).mode & 0o777).toBe(0o700);
  });

  it('keeps only what the person wrote: an empty or blank NOTES.md, a POLICY.md that is still the text every older version put there, and a link in their place are not copied (and no backup folder appears)', async () => {
    asDefaultHome();
    for (const [notes, policy] of [
      ['', OLD_DEFAULT_POLICY],
      ['  \n\n', null],
      [null, ''],
    ] as const) {
      fs.rmSync(path.join(env.home, 'memory'), { recursive: true, force: true });
      if (notes !== null) mk(path.join(env.home, 'memory', 'NOTES.md'), notes);
      if (policy !== null) mk(path.join(env.home, 'memory', 'POLICY.md'), policy);
      mk(path.join(env.home, 'memory', 'items.jsonl'), '{}\n');
      fs.rmSync(P.config(), { force: true });
      const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl }));
      expect(r.steps.backup).toBe('skipped');
      expect(gone(path.join(env.home, 'memory'))).toBe(true);
      expect(gone(P.backup())).toBe(true);
    }
    // a link where NOTES.md should be: what it points at is not read, not copied, not deleted
    const elsewhere = path.join(env.root, 'elsewhere.md');
    mk(elsewhere, 'not Jaffer\'s');
    mk(path.join(env.home, 'memory', 'items.jsonl'), '{}\n');
    fs.symlinkSync(elsewhere, path.join(env.home, 'memory', 'NOTES.md'));
    fs.rmSync(P.config(), { force: true });
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl }));
    expect(r.steps.backup).toBe('skipped');
    expect(gone(P.backup())).toBe(true);
    expect(read(elsewhere)).toBe('not Jaffer\'s');
  });

  it('runs once: a second start does nothing at all (no launchctl, no claude, not a file touched, the log as it was)', async () => {
    asDefaultHome();
    upgradedMac();
    const claude = fakeClaude();
    await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: claude.bin }));
    const homes = () => ({ ...snapshot(env.home), ...snapshot(env.userHome) });
    const before = homes();
    // the things it removed come back (as if an older Jaffer had run again): a second start still leaves them, it is done
    mk(P.plist(), '<plist/>');
    mk(path.join(env.home, 'memory', 'NOTES.md'), NOTES);
    const planted = homes();
    expect(Object.keys(planted).length).toBeGreaterThan(Object.keys(before).length);
    await new Promise((r) => setTimeout(r, 20)); // (an mtime written now would differ)
    const lc = fakeLaunchctl();
    let looked = false;
    const r = await migrateToPlainTerminal(opts({ launchctl: lc.launchctl, claudeBin: claude.bin, findClaude: async () => ((looked = true), claude.bin) }));
    expect(r.steps).toEqual(allSkipped);
    expect(lc.calls).toEqual([]);
    expect(claude.calls()).toEqual(['mcp remove jaffer -s user']); // only the first start's
    expect(looked).toBe(false);
    expect(homes()).toEqual(planted);
    expect(execFileMock).toHaveBeenCalledTimes(1); // the first start's claude, and nothing since
  });

  it.skipIf(process.getuid?.() === 0)('a step that fails does not stop the others: a launchctl that throws, an unreadable CLAUDE.md, a claude that exits 1; each is in migrate.log (names and codes, no paths), and the marker is set so the next start retries nothing', async () => {
    asDefaultHome();
    upgradedMac();
    fs.chmodSync(P.claudeMd(), 0o000);
    const log = quiet();
    try {
      const lc = fakeLaunchctl('throw');
      const claude = fakeClaude({ code: 1 });
      const r = await migrateToPlainTerminal(opts({ launchctl: lc.launchctl, claudeBin: claude.bin }));
      expect(r.steps).toEqual({ ...allDone, agent: 'failed', claudeMd: 'failed', mcp: 'failed' });
      expect(lc.calls).toEqual([['bootout', `gui/501/${AGENT_LABEL}`]]);
      expect(claude.calls()).toEqual(['mcp remove jaffer -s user']);
      // everything else was done
      expect(gone(P.plist())).toBe(true); // (the agent's files went before launchctl was asked)
      expect(gone(path.join(env.home, 'memory'))).toBe(true);
      expect(gone(path.join(env.home, 'session'))).toBe(true);
      expect(fs.readdirSync(P.backup()).sort()).toEqual(['NOTES.md', 'POLICY.md']);
      expect(gone(path.join(env.userHome, '.claude', 'skills', 'jaffer-release'))).toBe(true);
      expect(gone(P.codex())).toBe(true);
      expect(JSON.parse(read(P.config())).migrated).toBe(1);
      // and the log says what failed, with names and codes only
      const text = read(P.log());
      expect(text).toMatch(/agent failed/);
      expect(text).toMatch(/claudeMd failed: EACCES/);
      expect(text).toMatch(/mcp failed: exit 1/);
      expect(text).not.toContain(env.root);
      expect(fs.statSync(P.log()).mode & 0o777).toBe(0o600);
      // the next start: nothing is retried
      fs.chmodSync(P.claudeMd(), 0o644);
      const again = fakeLaunchctl();
      expect((await migrateToPlainTerminal(opts({ launchctl: again.launchctl, claudeBin: claude.bin }))).steps).toEqual(allSkipped);
      expect(again.calls).toEqual([]);
      expect(claude.calls()).toEqual(['mcp remove jaffer -s user']);
      expect(read(P.claudeMd())).toBe(MY_RULES + BLOCK + MY_AFTER); // (left as it was: Reset still takes it away)
    } finally {
      log.mockRestore();
    }
  });

  it('a claude that hangs is stopped at the timeout, the step is told as failed, and the rest is done', async () => {
    asDefaultHome();
    upgradedMac();
    const claude = fakeClaude('hang');
    const t0 = Date.now();
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: claude.bin, mcpTimeoutMs: 1_500 })); // (time enough for it to start and say its pid, also on a busy machine)
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.steps).toEqual({ ...allDone, mcp: 'failed' });
    expect(read(P.log())).toMatch(/mcp failed: timeout/);
    expect(read(P.claudeMd())).toBe(MY_RULES + MY_AFTER);
    // the hanging claude was killed, not left behind
    const pid = Number(read(claude.pidFile).trim());
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  it('a runner that never answers is let go at the timeout too', async () => {
    asDefaultHome();
    upgradedMac();
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: '/x/claude', run: () => new Promise(() => undefined), mcpTimeoutMs: 200 }));
    expect(r.steps.mcp).toBe('failed');
    expect(r.steps.claudeMd).toBe('done');
  });

  it('when the backup cannot be made the memory folder is kept (the notes are never lost), and everything else is done', async () => {
    asDefaultHome();
    upgradedMac();
    mk(P.backup().replace(/\/$/, ''), 'a file where the backup folder would go');
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(r.steps).toEqual({ ...allDone, backup: 'failed', oldData: 'failed' });
    expect(read(path.join(env.home, 'memory', 'NOTES.md'))).toBe(NOTES);
    expect(read(path.join(env.home, 'memory', 'POLICY.md'))).toBe(POLICY);
    expect(gone(path.join(env.home, 'session'))).toBe(true);
    expect(gone(path.join(env.home, 'bin', 'jafferd'))).toBe(true);
    expect(read(P.log())).toMatch(/oldData failed: memory kept/);
    expect(JSON.parse(read(P.config())).migrated).toBe(1);
  });

  it('never follows a link out of Jaffer\'s folder: a memory folder that is a link goes as a link (its target and the notes in it stay, nothing is read through it), and links inside memory are removed, not followed', async () => {
    asDefaultHome();
    upgradedMac();
    const outside = path.join(env.root, 'dropbox', 'jaffer-memory');
    mk(path.join(outside, 'NOTES.md'), 'notes kept elsewhere');
    mk(path.join(outside, 'deep', 'file.txt'), 'deep');
    fs.rmSync(path.join(env.home, 'memory'), { recursive: true });
    fs.symlinkSync(outside, path.join(env.home, 'memory'));
    const outside2 = path.join(env.root, 'projects', 'app');
    mk(path.join(outside2, 'src', 'index.ts'), 'code');
    fs.mkdirSync(path.join(env.home, 'session', 'x'), { recursive: true });
    fs.symlinkSync(outside2, path.join(env.home, 'session', 'x', 'project'));
    fs.symlinkSync(path.join(outside2, 'src', 'index.ts'), path.join(env.home, 'session', 'file-link'));
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(r.steps.oldData).toBe('done');
    expect(r.steps.backup).toBe('skipped');
    expect(gone(path.join(env.home, 'memory'))).toBe(true);
    expect(gone(path.join(env.home, 'session'))).toBe(true);
    expect(read(path.join(outside, 'NOTES.md'))).toBe('notes kept elsewhere');
    expect(read(path.join(outside, 'deep', 'file.txt'))).toBe('deep');
    expect(read(path.join(outside2, 'src', 'index.ts'))).toBe('code');
    expect(gone(P.backup())).toBe(true);
  });

  it('a bin folder that is a link out of Jaffer\'s folder: the jafferd in its target is not removed (by the migration or the login agent\'s cleanup)', async () => {
    asDefaultHome();
    upgradedMac();
    const outside = path.join(env.root, 'usr-local-bin');
    mk(path.join(outside, 'jafferd'), 'someone else\'s jafferd');
    fs.rmSync(path.join(env.home, 'bin'), { recursive: true });
    fs.symlinkSync(outside, path.join(env.home, 'bin'));
    const log = quiet();
    try {
      const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
      expect(read(path.join(outside, 'jafferd'))).toBe('someone else\'s jafferd');
      expect(r.steps.oldData).toBe('failed');
      expect(gone(path.join(env.home, 'memory'))).toBe(true); // (the rest still went)
      expect(read(P.log())).toMatch(/oldData failed: /);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a folder that is not clearly Jaffer\'s (a code checkout, a stranger\'s folder, the user\'s home): nothing in it or outside it is touched, no launchctl, no claude', async () => {
    upgradedMac();
    const checkout = path.join(env.root, 'code', 'jaffer');
    mk(path.join(checkout, '.git', 'HEAD'), 'ref');
    mk(path.join(checkout, 'package.json'), '{"name":"jaffer"}');
    mk(path.join(checkout, 'memory', 'NOTES.md'), 'source');
    mk(path.join(checkout, 'session', 'x'), 'source');
    const stranger = path.join(env.root, 'documents', 'jaffer-notes');
    mk(path.join(stranger, 'todo.txt'), 'buy milk');
    mk(path.join(stranger, 'notes', 'NOTES.md'), 'theirs');
    const log = quiet();
    try {
      for (const home of [checkout, stranger, env.userHome, path.join(env.userHome, 'Documents')]) {
        forcedHomes.add(home);
        const before = { ...snapshot(env.root) };
        const lc = fakeLaunchctl();
        const claude = fakeClaude();
        const r = await migrateToPlainTerminal({ home, userHome: env.userHome, uid: 501, launchctl: lc.launchctl, claudeBin: claude.bin });
        expect(r.steps, home).toEqual({ home: 'failed', ...allSkipped });
        expect(lc.calls).toEqual([]);
        expect(claude.calls()).toEqual([]);
        const after = snapshot(env.root);
        for (const k of Object.keys(after)) if (k.includes('fake-bin')) delete after[k];
        for (const k of Object.keys(before)) if (k.includes('fake-bin')) delete before[k];
        expect(after, home).toEqual(before);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('a home that is not the person\'s own ~/.jaffer (a smoke test, a dev build) is cleaned inside itself only: the login agent, Claude Code\'s files and the MCP server are left alone', async () => {
    upgradedMac(); // (env.home is not ~/.jaffer of the user running this: the real isDefaultHome says no)
    const lc = fakeLaunchctl();
    const claude = fakeClaude();
    const claudeSide = { ...snapshot(path.join(env.userHome, '.claude')), ...snapshot(path.join(env.userHome, '.codex')), ...snapshot(path.join(env.userHome, '.gemini')), ...snapshot(path.join(env.userHome, 'Library')) };
    const r = await migrateToPlainTerminal(opts({ launchctl: lc.launchctl, claudeBin: claude.bin }));
    expect(r.steps).toEqual({ ...allDone, agent: 'skipped', claudeMd: 'skipped', skills: 'skipped', firstDayBlocks: 'skipped', mcp: 'skipped' });
    expect(lc.calls).toEqual([]);
    expect(claude.calls()).toEqual([]);
    expect({ ...snapshot(path.join(env.userHome, '.claude')), ...snapshot(path.join(env.userHome, '.codex')), ...snapshot(path.join(env.userHome, '.gemini')), ...snapshot(path.join(env.userHome, 'Library')) }).toEqual(claudeSide);
    // inside its own folder it does its work
    expect(gone(path.join(env.home, 'memory'))).toBe(true);
    expect(gone(path.join(env.home, 'session'))).toBe(true);
    expect(gone(path.join(env.home, 'bin', 'jafferd'))).toBe(true);
    expect(fs.readdirSync(P.backup()).sort()).toEqual(['NOTES.md', 'POLICY.md']);
    expect(JSON.parse(read(P.config())).migrated).toBe(1);
  });

  it('a fresh install (no Jaffer folder yet) writes only the marker, and runs no claude (nothing of an older Jaffer can be registered)', async () => {
    asDefaultHome();
    const lc = fakeLaunchctl({ code: 3 });
    const claude = fakeClaude();
    let looked = false;
    const r = await migrateToPlainTerminal(opts({ launchctl: lc.launchctl, findClaude: async () => ((looked = true), claude.bin) }));
    expect(r.steps).toEqual({ ...allDone, backup: 'skipped', oldData: 'skipped', mcp: 'skipped' });
    expect(looked).toBe(false);
    expect(claude.calls()).toEqual([]);
    expect(JSON.parse(read(P.config()))).toEqual({ migrated: 1 });
    expect(fs.readdirSync(env.home).sort()).toEqual(['config.json', 'migrate.log']);
    expect(fs.statSync(env.home).mode & 0o777).toBe(0o700);
  });

  it('finds claude only when the step is due (an older Jaffer\'s home, not yet migrated), and with none found the step is skipped', async () => {
    asDefaultHome();
    upgradedMac();
    const claude = fakeClaude();
    let looked = 0;
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, findClaude: async () => (looked++, claude.bin) }));
    expect(r.steps.mcp).toBe('done');
    expect(looked).toBe(1);
    expect(claude.calls()).toEqual(['mcp remove jaffer -s user']);
    fs.rmSync(P.config());
    mk(path.join(env.home, 'run', 'x'), '');
    const none = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, findClaude: async () => null }));
    expect(none.steps.mcp).toBe('skipped');
  });

  it('touches nothing outside the two folders it is given: HOME points at an empty folder, and it stays empty', async () => {
    asDefaultHome();
    upgradedMac();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-not-home-'));
    try {
      vi.stubEnv('HOME', elsewhere);
      expect(os.homedir()).toBe(elsewhere);
      const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
      expect(r.steps).toEqual(allDone);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('never throws, and a config.json that cannot be read is kept aside, not lost', async () => {
    asDefaultHome();
    upgradedMac();
    fs.writeFileSync(P.config(), '{"onboarded": true, "appearance": {'); // cut off mid-write
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: fakeClaude().bin }));
    expect(r.steps.config).toBe('done');
    expect(read(path.join(env.home, 'config.json.unreadable'))).toBe('{"onboarded": true, "appearance": {');
    expect(JSON.parse(read(P.config()))).toEqual({ migrated: 1 });
    // a home it cannot even look into
    const log = quiet();
    try {
      await expect(migrateToPlainTerminal({ home: '\0bad', userHome: env.userHome, uid: 501 })).resolves.toMatchObject({ steps: { home: 'failed' } });
    } finally {
      log.mockRestore();
    }
  });

  it('without a launchctl of its own the real one is never reached: /bin/launchctl is asked of the fake execFile and refused; under the kill switch not even that', async () => {
    asDefaultHome();
    upgradedMac();
    const log = quiet();
    try {
      vi.stubEnv('JAFFER_NO_LAUNCHCTL', '1');
      await migrateToPlainTerminal(opts({ claudeBin: fakeClaude().bin }));
      expect(real.refused).toEqual([]);
      expect(gone(P.plist())).toBe(true);

      vi.stubEnv('JAFFER_NO_LAUNCHCTL', '');
      upgradedMac();
      fs.rmSync(P.config());
      await migrateToPlainTerminal(opts({ claudeBin: fakeClaude().bin }));
      if (process.platform === 'darwin') expect(real.refused).toEqual(['/bin/launchctl']);
    } finally {
      log.mockRestore();
    }
  });

  it('runs claude with its own folder first on its PATH: a claude installed with npm is a script that starts the node next to it, and an app opened from the Finder has a short PATH', async () => {
    asDefaultHome();
    upgradedMac();
    const dir = path.join(env.root, 'npm-bin');
    mk(path.join(dir, 'jaffer-test-node'), '#!/bin/sh\nexec /bin/sh "$@"\n'); // (a stand-in for node: it runs the script)
    mk(path.join(dir, 'claude'), `#!/usr/bin/env jaffer-test-node\necho "$*" >> '${path.join(env.root, 'npm-calls.log')}'\nexit 0\n`);
    for (const f of ['jaffer-test-node', 'claude']) fs.chmodSync(path.join(dir, f), 0o755);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: path.join(dir, 'claude') }));
    expect(r.steps.mcp).toBe('done');
    expect(read(path.join(env.root, 'npm-calls.log'))).toBe('mcp remove jaffer -s user\n');
  });

  it('a claude that is not a stand-in in the test\'s folder is never run (the fake execFile refuses it): the step fails, nothing else changes', async () => {
    asDefaultHome();
    upgradedMac();
    const r = await migrateToPlainTerminal(opts({ launchctl: fakeLaunchctl().launchctl, claudeBin: '/usr/local/bin/claude' }));
    expect(real.refused).toEqual(['/usr/local/bin/claude']);
    expect(r.steps).toEqual({ ...allDone, mcp: 'failed' });
  });
});

describe('prepareHome: the app runs the migration at its start, before its terminal', () => {
  it('hands it the person\'s home, this user\'s uid and a lazy finder for claude, and never throws', async () => {
    const seen: MigrateOptions[] = [];
    const paths = makePaths(env.home);
    await prepareHome(paths, { userHome: env.userHome, uid: 501, migrate: async (o) => (seen.push(o), { steps: {} }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ home: env.home, userHome: env.userHome, uid: 501 });
    expect(seen[0]!.claudeBin).toBeUndefined(); // (found only when the step is due: a login shell can take seconds)
    expect(typeof seen[0]!.findClaude).toBe('function');
    await expect(prepareHome(paths, { userHome: env.userHome, uid: 501, migrate: async () => Promise.reject(new Error('boom')) })).resolves.toBeUndefined();
  });

  it('by default it uses this process\'s home folder and uid', async () => {
    const seen: MigrateOptions[] = [];
    await prepareHome(makePaths(env.home), { migrate: async (o) => (seen.push(o), { steps: {} }) });
    expect(seen[0]).toMatchObject({ userHome: os.homedir(), uid: process.getuid!() });
  });

  it('main.ts runs it after the older session is ended and before its own terminal starts', () => {
    const main = read(path.resolve(__dirname, '..', 'src', 'main', 'main.ts'));
    const start = main.slice(main.indexOf('app.whenReady().then('));
    const [older, prepare, terminal] = ['await endOlderSession()', 'await prepareHomeBounded()', 'await startTerminal()'].map((s) => start.indexOf(s)) as [number, number, number];
    expect(older).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(older);
    expect(terminal).toBeGreaterThan(prepare);
  });
});
