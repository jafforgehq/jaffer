import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanEnv, makeEnv, type TestEnv } from './helpers/env';
import { launchDaemon } from '../src/core/daemon-client';
import { AGENT_LABEL, removeLegacyAgent } from '../src/core/service/legacy-agent';
import { makePaths } from '../src/shared/paths';

/**
 * The cleanup of the login agent that Jaffer 0.5 could install (`removeLegacyAgent`). It runs `launchctl bootout` and deletes two files,
 * so every test here hands it a fake `launchctl` and a temporary user home: nothing here may ever reach the real launchd or the real
 * `~/Library/LaunchAgents`. Two things are stood in for to make sure of it:
 * - `isDefaultHome` says yes to the temporary homes a test names (`asDefaultHome`), and otherwise answers as the real one does (a
 *   temporary home is never the person's own `~/.jaffer`);
 * - `execFile`, which the cleanup uses only to run `/bin/launchctl` when none is given, is a fake that records the call and fails it.
 */
const { forcedHomes, execFileMock } = vi.hoisted(() => ({
  forcedHomes: new Set<string>(),
  execFileMock: vi.fn(),
}));
vi.mock('../src/core/session/caffeinate', async (orig) => {
  const actual = await orig<typeof import('../src/core/session/caffeinate')>();
  return { ...actual, isDefaultHome: (home: string) => forcedHomes.has(home) || actual.isDefaultHome(home) };
});
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), execFile: execFileMock }));

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  forcedHomes.clear();
  execFileMock.mockReset();
  // what the real launchctl says for a job it does not know ("Boot-out failed: 3: No such process"): nothing real is ever run
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    cb(Object.assign(new Error('Boot-out failed: 3: No such process'), { code: 3 }), '', 'Boot-out failed: 3: No such process');
    return {};
  });
  vi.stubEnv('JAFFER_NO_LAUNCHCTL', ''); // (the test run sets it: the fake launchctl below must be reachable)
});
afterEach(() => {
  vi.unstubAllEnvs();
  env.cleanup();
});

const mk = (p: string, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const asDefaultHome = () => forcedHomes.add(env.home);

const TARGET = (uid: number) => `gui/${uid}/${AGENT_LABEL}`;
const plistPath = () => path.join(env.userHome, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const wrapperPath = () => path.join(env.home, 'bin', 'jafferd');
/** The agent as 0.5 left it: the plist in the person's LaunchAgents, its wrapper in Jaffer's folder, and neighbours that are not its. */
function seed(): void {
  mk(plistPath(), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n');
  mk(wrapperPath(), '#!/bin/sh\n');
  mk(path.join(env.userHome, 'Library', 'LaunchAgents', 'com.example.other.plist'), '<plist/>');
  mk(path.join(env.home, 'bin', 'jaffer'), '#!/bin/sh\n'); // the command-line wrapper is not the agent's
  mk(path.join(env.home, 'config.json'), '{}');
}
const neighboursKept = () =>
  fs.existsSync(path.join(env.userHome, 'Library', 'LaunchAgents', 'com.example.other.plist')) && fs.existsSync(path.join(env.home, 'bin', 'jaffer')) && fs.existsSync(path.join(env.home, 'config.json'));

function fakeLaunchctl(answer: { code: number } | 'throw' | 'reject' = { code: 0 }, onCall?: (args: string[]) => void) {
  const calls: string[][] = [];
  const launchctl = (args: string[]): Promise<{ code: number }> => {
    calls.push(args);
    onCall?.(args);
    if (answer === 'throw') throw new Error('launchctl exploded');
    if (answer === 'reject') return Promise.reject(new Error('launchctl exploded'));
    return Promise.resolve(answer);
  };
  return { launchctl, calls };
}

describe('removeLegacyAgent: the login agent of an older Jaffer (a fake launchctl and a temporary user home; the real ones are never touched)', () => {
  it('boots the job out once with the right label and deletes its plist and wrapper, and only those', async () => {
    asDefaultHome();
    seed();
    const f = fakeLaunchctl();
    const r = await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl });
    expect(r).toEqual({ removed: true });
    expect(f.calls).toEqual([['bootout', TARGET(501)]]);
    expect(TARGET(501)).toBe('gui/501/com.jafforge.jaffer.daemon');
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(fs.existsSync(wrapperPath())).toBe(false);
    expect(neighboursKept()).toBe(true);
  });

  it('uses the uid it is given for launchd\'s domain', async () => {
    asDefaultHome();
    seed();
    const f = fakeLaunchctl();
    await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 777, launchctl: f.launchctl });
    expect(f.calls).toEqual([['bootout', 'gui/777/com.jafforge.jaffer.daemon']]);
  });

  it('deletes the files before it boots the job out (the bootout ends the daemon when launchd runs it, and may end what asked for it)', async () => {
    asDefaultHome();
    seed();
    let atBootout: { plist: boolean; wrapper: boolean } | null = null;
    const f = fakeLaunchctl({ code: 0 }, () => (atBootout = { plist: fs.existsSync(plistPath()), wrapper: fs.existsSync(wrapperPath()) }));
    await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl });
    expect(atBootout).toEqual({ plist: false, wrapper: false });
  });

  it('a job launchd does not know is fine: the files are still removed, and that counts as removed', async () => {
    asDefaultHome();
    for (const code of [3, 113]) {
      seed();
      const f = fakeLaunchctl({ code }); // "Boot-out failed: 3: No such process", "Could not find service"
      expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).toEqual({ removed: true });
      expect(fs.existsSync(plistPath()) || fs.existsSync(wrapperPath())).toBe(false);
    }
  });

  it('with nothing installed it is no error and nothing is removed (the bootout is still asked: a job can be loaded after its files went)', async () => {
    asDefaultHome();
    fs.mkdirSync(env.userHome, { recursive: true });
    const f = fakeLaunchctl({ code: 3 });
    expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).toEqual({ removed: false });
    expect(f.calls).toEqual([['bootout', TARGET(501)]]);
    // a job that was loaded with no files left is unloaded all the same
    expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: fakeLaunchctl({ code: 0 }).launchctl })).toEqual({ removed: true });
  });

  it('a second call, once it is gone, is silent: nothing removed, nothing thrown', async () => {
    asDefaultHome();
    seed();
    const f = fakeLaunchctl();
    expect((await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).removed).toBe(true);
    const again = fakeLaunchctl({ code: 3 });
    expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: again.launchctl })).toEqual({ removed: false });
    expect(neighboursKept()).toBe(true);
  });

  it('a home that is not the person\'s own (a test home, a second install) is not touched: no files, no launchctl', async () => {
    seed(); // (env.home is not ~/.jaffer of the user running this: the real isDefaultHome says no)
    const f = fakeLaunchctl();
    expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).toEqual({ removed: false });
    expect(f.calls).toEqual([]);
    expect(fs.existsSync(plistPath())).toBe(true);
    expect(fs.existsSync(wrapperPath())).toBe(true);
  });

  it('JAFFER_NO_LAUNCHCTL=1 is a kill switch: launchctl is never run (not even the one given), the files are still removed', async () => {
    asDefaultHome();
    seed();
    vi.stubEnv('JAFFER_NO_LAUNCHCTL', '1');
    const f = fakeLaunchctl();
    const r = await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl });
    expect(f.calls).toEqual([]);
    expect(r).toEqual({ removed: true });
    expect(fs.existsSync(plistPath()) || fs.existsSync(wrapperPath())).toBe(false);
    expect(neighboursKept()).toBe(true);
  });

  it('without a launchctl of its own it runs /bin/launchctl bootout (here a fake execFile: the real one is never run), and not at all under the kill switch', async () => {
    asDefaultHome();
    seed();
    vi.stubEnv('JAFFER_NO_LAUNCHCTL', '1');
    await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501 });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fs.existsSync(plistPath()) || fs.existsSync(wrapperPath())).toBe(false);

    vi.stubEnv('JAFFER_NO_LAUNCHCTL', '');
    seed();
    const r = await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501 });
    if (process.platform === 'darwin') {
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0]![0]).toBe('/bin/launchctl');
      expect(execFileMock.mock.calls[0]![1]).toEqual(['bootout', TARGET(501)]);
      expect(execFileMock.mock.calls[0]![2]).toMatchObject({ timeout: 20_000, killSignal: 'SIGKILL' }); // (bounded: a launchctl that hangs is killed)
    } else {
      expect(execFileMock).not.toHaveBeenCalled(); // (no launchd off macOS)
    }
    expect(r.removed).toBe(true); // the files went; launchd said "no such process"
  });

  it('a launchctl that throws or rejects: removed is false, nothing is thrown, and the files were still taken away', async () => {
    asDefaultHome();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const how of ['throw', 'reject'] as const) {
        seed();
        const f = fakeLaunchctl(how);
        await expect(removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).resolves.toEqual({ removed: false });
        expect(f.calls).toEqual([['bootout', TARGET(501)]]);
        expect(fs.existsSync(plistPath()) || fs.existsSync(wrapperPath())).toBe(false);
        expect(neighboursKept()).toBe(true);
      }
      expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('launchctl exploded'); // the failure is told, not hidden
    } finally {
      log.mockRestore();
    }
  });

  it('a file that cannot be removed does not stop the rest: the other file goes, the job is still booted out, removed is false, nothing is thrown', async () => {
    asDefaultHome();
    seed();
    // (a plist that is a folder with something in it: rmSync without `recursive` refuses it)
    fs.rmSync(plistPath());
    mk(path.join(plistPath(), 'inside'), 'x');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = fakeLaunchctl();
      await expect(removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).resolves.toEqual({ removed: false });
      expect(fs.existsSync(wrapperPath())).toBe(false);
      expect(f.calls).toEqual([['bootout', TARGET(501)]]);
      expect(fs.existsSync(path.join(plistPath(), 'inside'))).toBe(true); // (nothing deeper was deleted to get around it)
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a bin folder that is a link out of Jaffer\'s folder is not followed: the jafferd in its target stays, the failure is told (onError) and the plist still goes', async () => {
    asDefaultHome();
    seed();
    const outside = path.join(env.root, 'usr-local-bin');
    mk(path.join(outside, 'jafferd'), "someone else's jafferd");
    fs.rmSync(path.join(env.home, 'bin'), { recursive: true });
    fs.symlinkSync(outside, path.join(env.home, 'bin'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const errors: unknown[] = [];
      const f = fakeLaunchctl();
      expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl, onError: (e) => errors.push(e) })).toEqual({ removed: false });
      expect(fs.readFileSync(path.join(outside, 'jafferd'), 'utf8')).toBe("someone else's jafferd");
      expect(errors.map((e) => (e as { code?: string }).code)).toEqual(['ELINK']);
      expect(fs.existsSync(plistPath())).toBe(false);
      expect(f.calls).toEqual([['bootout', TARGET(501)]]);
    } finally {
      log.mockRestore();
    }
  });

  it('removes a link in the plist\'s place, and never what it points at', async () => {
    asDefaultHome();
    const elsewhere = path.join(env.root, 'elsewhere.plist');
    mk(elsewhere, 'the person\'s own file');
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.symlinkSync(elsewhere, plistPath());
    const f = fakeLaunchctl();
    expect(await removeLegacyAgent({ home: env.home, userHome: env.userHome, uid: 501, launchctl: f.launchctl })).toEqual({ removed: true });
    expect(fs.lstatSync(plistPath(), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe("the person's own file");
  });
});

describe('safety: the tests can never reach the real launchctl', () => {
  it('a test that cleans the environment for the daemon it starts (the README screenshots) keeps the kill switch', () => {
    const env = cleanEnv({ PATH: '/usr/bin:/bin', JAFFER_NO_LAUNCHCTL: '1', JAFFER_HOME: '/x/.jaffer', JAFFER_SESSION: '1', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', ZDOTDIR: '/z' });
    expect(env).toEqual({ PATH: '/usr/bin:/bin', JAFFER_NO_LAUNCHCTL: '1' });
    expect(fs.readFileSync(path.resolve(__dirname, 'e2e', 'screenshots.test.ts'), 'utf8')).toMatch(/import \{ cleanEnv \} from '\.\.\/helpers\/env'/);
  });

  it('every test run has the kill switch on (vitest.config.ts, vitest.e2e.config.ts), and what the tests spawn inherits it, the daemon too', () => {
    vi.unstubAllEnvs(); // (this file lowers it for its own tests: what the run itself sets is what counts here)
    expect(process.env.JAFFER_NO_LAUNCHCTL).toBe('1');
    for (const config of ['vitest.config.ts', 'vitest.e2e.config.ts']) expect(fs.readFileSync(path.resolve(__dirname, '..', config), 'utf8'), config).toMatch(/JAFFER_NO_LAUNCHCTL: '1'/);
    // a child process, as the tests spawn the bundled CLI and daemon (with process.env, or a copy of it with more in it)
    for (const e of [undefined, { ...process.env, HOME: os.tmpdir() }]) {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.JAFFER_NO_LAUNCHCTL))'], { encoding: 'utf8', env: e });
      expect(r.stdout).toBe('1');
    }
    // and the daemon as the launcher starts it
    const spawned: { env?: NodeJS.ProcessEnv }[] = [];
    launchDaemon(makePaths(path.join(env.root, '.jaffer-launched')), { execPath: '/x/node', daemonScript: path.join(env.root, 'jafferd.cjs'), env: { HOME: env.root }, spawn: (_c, _a, o) => (spawned.push(o), { unref: () => undefined }) });
    expect(spawned[0]!.env?.JAFFER_NO_LAUNCHCTL).toBe('1');
  });
});
