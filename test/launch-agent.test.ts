import { execFileSync, spawnSync, type execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchAgent, agentFiles, agentPaths, execLaunchctl, planAgent, type AgentFiles, type AgentPlan, type Launchctl, type LaunchAgentFs, type PlanInput } from '../src/core/service/launch-agent';
import { AGENT_LABEL, agentStatusText } from '../src/shared/keep-running';
import { KeepRunning } from '../src/daemon/keep-running';
import { daemonAgent, defaultDaemonAgent, ensureDaemon, launchDaemon, type Launcher } from '../src/core/daemon-client';
import { makePaths } from '../src/shared/paths';

/**
 * Nothing here ever runs the real `launchctl` or touches the real ~/Library/LaunchAgents: the agent is driven through a recording fake
 * `Launchctl` (a little launchd of its own) and an in-memory file system. The only real processes are `plutil` and `sh -n` on files in a
 * temporary folder, and `sh` running a wrapper whose app is a stand-in script in that folder.
 */

const BASE: PlanInput = {
  home: '/Users/me/.jaffer',
  defaultHome: '/Users/me/.jaffer',
  userHome: '/Users/me',
  uid: 501,
  platform: 'darwin',
  execPath: '/Applications/Jaffer.app/Contents/MacOS/Jaffer',
  daemonScript: '/Applications/Jaffer.app/Contents/Resources/app.asar/dist/daemon/jafferd.cjs',
  electron: true,
};
const plan = (over: Partial<PlanInput> = {}): AgentPlan => {
  const p = planAgent({ ...BASE, ...over });
  if ('refused' in p) throw new Error(`refused: ${p.refused}`);
  return p;
};
const TARGET = `gui/501/${AGENT_LABEL}`;

describe('planAgent: what is refused', () => {
  it('refuses a platform that is not macOS', () => {
    const p = planAgent({ ...BASE, platform: 'linux' });
    expect(p).toEqual({ refused: expect.stringMatching(/macOS/) });
  });

  it('refuses a home that is not the default one (tests and development homes never touch the real LaunchAgents)', () => {
    const p = planAgent({ ...BASE, home: '/tmp/jaffer-test-1/.jaffer' });
    expect(p).toEqual({ refused: expect.stringMatching(/~\/\.jaffer|another folder/) });
  });

  it('refuses an app that runs from a translocated or mounted path, and says to move it', () => {
    for (const execPath of ['/private/var/folders/xx/T/AppTranslocation/ABC-123/d/Jaffer.app/Contents/MacOS/Jaffer', '/Volumes/Jaffer 1.2/Jaffer.app/Contents/MacOS/Jaffer']) {
      const p = planAgent({ ...BASE, execPath });
      expect(p, execPath).toEqual({ refused: expect.stringMatching(/Applications/) });
    }
  });

  it('refuses a path with a control character, which no plist can carry', () => {
    expect(planAgent({ ...BASE, execPath: '/Applications/Jaf\nfer.app/Contents/MacOS/Jaffer' })).toEqual({ refused: expect.any(String) });
    expect(planAgent({ ...BASE, daemonScript: '/x/jafferd\u0001.cjs' })).toEqual({ refused: expect.any(String) });
  });

  it('plans a normal /Applications install', () => {
    const p = plan();
    expect(p.plistPath).toBe(`/Users/me/Library/LaunchAgents/${AGENT_LABEL}.plist`);
    expect(p.wrapperPath).toBe('/Users/me/.jaffer/bin/jafferd');
    expect(agentPaths(BASE)).toEqual({ plistPath: p.plistPath, wrapperPath: p.wrapperPath });
  });
});

describe('planAgent: the plist', () => {
  const squash = (s: string) => s.replace(/\s+/g, ' ');

  it('has every required key and value', () => {
    const t = squash(plan().plist);
    expect(t).toContain(`<key>Label</key> <string>${AGENT_LABEL}</string>`);
    expect(t).toContain('<key>RunAtLoad</key> <true/>');
    expect(t).toContain('<key>KeepAlive</key> <dict> <key>SuccessfulExit</key> <false/> </dict>');
    expect(t).toContain('<key>ThrottleInterval</key> <integer>5</integer>');
    expect(t).toContain('<key>LimitLoadToSessionType</key> <string>Aqua</string>');
    expect(t).toContain('<key>ProgramArguments</key> <array> <string>/Users/me/.jaffer/bin/jafferd</string> </array>');
    expect(t).toContain('<key>EnvironmentVariables</key> <dict> <key>JAFFER_HOME</key> <string>/Users/me/.jaffer</string> </dict>');
    expect(t).toContain('<key>StandardOutPath</key> <string>/Users/me/.jaffer/run/jafferd.log</string>');
    expect(t).toContain('<key>StandardErrorPath</key> <string>/Users/me/.jaffer/run/jafferd.log</string>');
  });

  it('carries JAFFER_HOME and nothing else in the environment, and no secret', () => {
    const t = plan().plist;
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(t)?.[1] ?? '';
    expect([...env.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1])).toEqual(['JAFFER_HOME']);
    expect(t).not.toMatch(/ANTHROPIC|API_KEY|TOKEN|SECRET|PASSWORD|sk-ant/i);
  });

  it.skipIf(process.platform !== 'darwin')('passes plutil -lint', () => {
    withTemp((dir) => {
      const file = path.join(dir, 'agent.plist');
      fs.writeFileSync(file, plan().plist);
      expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
    });
  });
});

describe('planAgent: the wrapper', () => {
  it('is a sh script that checks the app, takes the agent away when it is gone, and otherwise execs it', () => {
    const w = plan().wrapper;
    expect(w.startsWith('#!/bin/sh\n')).toBe(true);
    expect(w).toContain(`[ ! -x '${BASE.execPath}' ]`); // the existence check
    expect(w).toContain(`/bin/launchctl bootout ${TARGET}`); // the self-removal: the job,
    expect(w).toContain(`'/Users/me/Library/LaunchAgents/${AGENT_LABEL}.plist'`); // the plist,
    expect(w).toContain(`'/Users/me/.jaffer/bin/jafferd'`); // and the wrapper itself
    expect(w).toMatch(/exit 0/);
    expect(w).toContain(`exec '${BASE.execPath}' '${BASE.daemonScript}'`);
  });

  it('removes the files before the bootout, because the bootout ends this very script', () => {
    const w = plan().wrapper;
    expect(w.indexOf('rm -f')).toBeGreaterThan(-1);
    expect(w.indexOf('rm -f')).toBeLessThan(w.indexOf('bootout'));
  });

  it('runs the daemon as node only when the binary is Electron', () => {
    expect(plan({ electron: true }).wrapper).toContain(`ELECTRON_RUN_AS_NODE=1 exec '${BASE.execPath}'`);
    expect(plan({ electron: false }).wrapper).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('is valid sh', () => {
    withTemp((dir) => {
      const file = path.join(dir, 'jafferd');
      fs.writeFileSync(file, plan().wrapper);
      const r = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  });
});

describe('a path with a space, an ampersand, angle brackets and quotes', () => {
  const ODD = `it's & <my> "odd" app`;

  it('still gives a plist that parses with the exact paths, and a valid wrapper holding the exact quoted path', () => {
    withTemp((dir) => {
      const execPath = path.join(dir, ODD, 'Jaffer');
      const daemonScript = path.join(dir, ODD, 'Resources', 'jafferd.cjs');
      const home = path.join(dir, ODD, '.jaffer');
      const p = plan({ home, defaultHome: home, userHome: path.join(dir, ODD), execPath, daemonScript });

      // the wrapper: valid sh, with the path single-quoted (an embedded ' written as '\'')
      const wrapper = path.join(dir, 'wrapper.sh');
      fs.writeFileSync(wrapper, p.wrapper);
      const syntax = spawnSync('/bin/sh', ['-n', wrapper], { encoding: 'utf8' });
      expect(syntax.stderr).toBe('');
      expect(syntax.status).toBe(0);
      expect(p.wrapper).toContain(`'${execPath.replace(/'/g, `'\\''`)}'`);

      // the plist: no raw & or < from the path
      expect(p.plist).not.toContain('it\'s & <my>');
      expect(p.plist).toContain('it&apos;s &amp; &lt;my&gt; &quot;odd&quot; app');
      if (process.platform === 'darwin') {
        const file = path.join(dir, 'agent.plist');
        fs.writeFileSync(file, p.plist);
        expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
        const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
        expect(json).toEqual({
          Label: AGENT_LABEL,
          ProgramArguments: [path.join(home, 'bin', 'jafferd')],
          EnvironmentVariables: { JAFFER_HOME: home },
          RunAtLoad: true,
          KeepAlive: { SuccessfulExit: false },
          ThrottleInterval: 5,
          LimitLoadToSessionType: 'Aqua',
          StandardOutPath: path.join(home, 'run', 'jafferd.log'),
          StandardErrorPath: path.join(home, 'run', 'jafferd.log'),
        });
      }
    });
  });

  it('runs the app with exactly the daemon script as its argument, and the Electron switch only when asked', () => {
    withTemp((dir) => {
      const appDir = path.join(dir, ODD);
      fs.mkdirSync(appDir, { recursive: true });
      const execPath = path.join(appDir, 'Jaffer');
      // a stand-in app: it prints what it was started with, one thing per line
      fs.writeFileSync(execPath, '#!/bin/sh\nprintf "node=%s\\n" "$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n', { mode: 0o755 });
      fs.chmodSync(execPath, 0o755);
      expect(() => fs.accessSync(execPath, fs.constants.X_OK)).not.toThrow(); // (the wrapper's other branch is never run here)
      const daemonScript = path.join(appDir, 'a daemon & script.cjs');
      for (const electron of [true, false]) {
        const wrapper = path.join(dir, `wrapper-${electron}.sh`);
        fs.writeFileSync(wrapper, plan({ execPath, daemonScript, electron, uid: 99999 }).wrapper);
        const r = spawnSync('/bin/sh', [wrapper], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.split('\n').filter(Boolean)).toEqual([`node=${electron ? '1' : ''}`, `arg=${daemonScript}`]);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------- LaunchAgent

/** An in-memory file system with just what the agent uses. */
function memFs() {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  const fsx = {
    files,
    dirs,
    writes,
    writeFileSync: (p: unknown, data: unknown, opts?: unknown) => {
      const mode = typeof opts === 'object' && opts !== null && typeof (opts as { mode?: number }).mode === 'number' ? (opts as { mode: number }).mode : 0o666;
      files.set(String(p), { data: String(data), mode });
      writes.push(String(p));
    },
    mkdirSync: (p: unknown) => {
      dirs.add(String(p));
      return undefined;
    },
    rmSync: (p: unknown) => void files.delete(String(p)),
    // a rename puts the file at its new name (a write as far as the order of what appeared on disk goes)
    renameSync: (from: unknown, to: unknown) => {
      const f = files.get(String(from));
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.delete(String(from));
      files.set(String(to), f);
      writes.push(String(to));
    },
    existsSync: (p: unknown) => files.has(String(p)),
    chmodSync: (p: unknown, mode: unknown) => {
      const f = files.get(String(p));
      if (f) f.mode = Number(mode);
    },
    readFileSync: (p: unknown) => {
      const f = files.get(String(p));
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return f.data;
    },
  };
  return fsx;
}

/** A little launchd: remembers whether the job is loaded and whether it runs, and records every call it gets. */
function fakeLaunchd(start: { loaded?: boolean; pid?: number | null; bootstrapFails?: string; onCall?: (args: string[]) => void } = {}) {
  const st = { loaded: !!start.loaded, pid: start.pid === undefined ? (start.loaded ? 4242 : null) : start.pid }; // (pid: null is a job with no process)
  const calls: string[][] = [];
  const launchctl: Launchctl = {
    async run(args) {
      calls.push(args);
      start.onCall?.(args);
      const [verb, ...rest] = args;
      if (verb === 'print') return st.loaded ? { code: 0, out: `${TARGET} = {\n\tactive count = ${st.pid ? 1 : 0}\n\tstate = ${st.pid ? 'running' : 'not running'}\n${st.pid ? `\tpid = ${st.pid}\n` : ''}\tlast exit code = 0\n}\n` } : { code: 113, out: `Could not find service "${AGENT_LABEL}" in domain for user gui: 501` };
      if (verb === 'bootstrap') {
        if (start.bootstrapFails) return { code: 5, out: start.bootstrapFails };
        if (st.loaded) return { code: 5, out: 'Bootstrap failed: 5: Input/output error' };
        st.loaded = true;
        st.pid = 4242;
        return { code: 0, out: '' };
      }
      if (verb === 'bootout') {
        if (!st.loaded) return { code: 3, out: 'Boot-out failed: 3: No such process' };
        st.loaded = false;
        st.pid = null;
        return { code: 0, out: '' };
      }
      if (verb === 'kickstart') return st.loaded && rest[0] === TARGET ? { code: 0, out: '' } : { code: 113, out: 'Could not find service' };
      return { code: 1, out: `unexpected: ${args.join(' ')}` };
    },
  };
  return { launchctl, calls, st };
}

const make = (start?: Parameters<typeof fakeLaunchd>[0]) => {
  const fsx = memFs();
  const d = fakeLaunchd(start);
  const agent = new LaunchAgent({ launchctl: d.launchctl, uid: 501, fs: fsx as unknown as LaunchAgentFs });
  return { fsx, ...d, agent };
};
/** Put the files of a plan on the in-memory disk, as an earlier install would have left them. */
const seed = (fsx: ReturnType<typeof memFs>, p: AgentPlan, over: Partial<AgentPlan> = {}) => {
  fsx.files.set(p.wrapperPath, { data: over.wrapper ?? p.wrapper, mode: 0o755 });
  fsx.files.set(p.plistPath, { data: over.plist ?? p.plist, mode: 0o644 });
  fsx.writes.length = 0;
};

describe('LaunchAgent.install', () => {
  it('writes the wrapper (0755) and the plist (0644), makes their folders, and bootstraps the job', async () => {
    const { fsx, calls, agent } = make();
    const p = plan();
    await agent.install(p);
    expect(fsx.files.get(p.wrapperPath)).toEqual({ data: p.wrapper, mode: 0o755 });
    expect(fsx.files.get(p.plistPath)).toEqual({ data: p.plist, mode: 0o644 });
    expect(fsx.dirs).toContain('/Users/me/Library/LaunchAgents');
    expect(fsx.dirs).toContain('/Users/me/.jaffer/bin');
    expect(fsx.dirs).toContain('/Users/me/.jaffer/run'); // launchd opens the log before it starts the job
    expect(fsx.writes.indexOf(p.wrapperPath)).toBeLessThan(fsx.writes.indexOf(p.plistPath)); // the plist never points at a missing wrapper
    expect(calls).toEqual([['print', TARGET], ['bootstrap', 'gui/501', p.plistPath]]);
  });

  it('boots out a job that is loaded but not running first (bootstrap would fail on it), ignoring a failure of that', async () => {
    const { calls, agent, st } = make({ loaded: true, pid: null });
    const p = plan();
    await agent.install(p);
    expect(calls.map((c) => c[0])).toEqual(['print', 'bootout', 'bootstrap']);
    expect(st.loaded).toBe(true);
    // and when the bootout itself fails, the bootstrap is still tried
    const calls2: string[][] = [];
    const stubborn: Launchctl = {
      async run(args) {
        calls2.push(args);
        return args[0] === 'print' ? { code: 0, out: 'state = not running' } : args[0] === 'bootout' ? { code: 3, out: 'No such process' } : { code: 0, out: '' };
      },
    };
    await new LaunchAgent({ launchctl: stubborn, uid: 501, fs: memFs() as unknown as LaunchAgentFs }).install(p);
    expect(calls2.map((c) => c[0])).toEqual(['print', 'bootout', 'bootstrap']);
  });

  it('writes the files but leaves a running job alone: booting it out from the daemon it runs would end the session', async () => {
    const { fsx, calls, agent } = make({ loaded: true, pid: 777 });
    const p = plan();
    await agent.install(p);
    expect(fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(calls).toEqual([['print', TARGET]]);
  });

  it('says why when launchd refuses the job, and leaves the files for the next try', async () => {
    const { fsx, agent } = make({ bootstrapFails: 'Bootstrap failed: 5: Input/output error' });
    const p = plan();
    await expect(agent.install(p)).rejects.toThrow(/Input\/output error/);
    expect(fsx.files.has(p.plistPath)).toBe(true);
  });
});

describe('LaunchAgent.remove', () => {
  it('deletes both files and boots the job out, last (that ends the daemon when it is the one running)', async () => {
    const fsx = memFs();
    let filesAtBootout = -1;
    const { launchctl, calls } = fakeLaunchd({ loaded: true, pid: 4242, onCall: (a) => void (a[0] === 'bootout' && (filesAtBootout = fsx.files.size)) });
    const agent = new LaunchAgent({ launchctl, uid: 501, fs: fsx as unknown as LaunchAgentFs });
    const p = plan();
    seed(fsx, p);
    await agent.remove(p);
    expect(fsx.files.size).toBe(0);
    expect(filesAtBootout).toBe(0);
    expect(calls).toEqual([['bootout', TARGET]]);
  });

  it('is silent when nothing is installed (a failing bootout is ignored)', async () => {
    const { fsx, calls, agent } = make();
    // (the bootout's failure is not thrown: it is handed back, for Reset and `jaffer service` to tell)
    await expect(agent.remove(plan())).resolves.toEqual({ code: 3, out: 'Boot-out failed: 3: No such process' });
    expect(fsx.files.size).toBe(0);
    expect(fsx.writes).toEqual([]);
    expect(calls).toEqual([['bootout', TARGET]]);
  });
});

describe('LaunchAgent.status', () => {
  it('is not-installed with no plist, without asking launchd', async () => {
    const { calls, agent } = make({ loaded: true });
    expect(await agent.status(plan())).toEqual({ state: 'not-installed' });
    expect(calls).toEqual([]);
  });

  it('is running with the pid launchd prints', async () => {
    const { fsx, agent } = make({ loaded: true, pid: 31337 });
    const p = plan();
    seed(fsx, p);
    expect(await agent.status(p)).toEqual({ state: 'running', pid: 31337 });
  });

  it('is not-loaded when launchd does not know the job, or knows it with no process', async () => {
    const gone = make();
    const p = plan();
    seed(gone.fsx, p);
    expect(await gone.agent.status(p)).toEqual({ state: 'not-loaded' });
    const idle = make({ loaded: true, pid: null });
    seed(idle.fsx, p);
    expect(await idle.agent.status(p)).toEqual({ state: 'not-loaded' });
  });

  it('is refused, with the reason, for a refused plan', async () => {
    const { calls, agent } = make();
    expect(await agent.status({ refused: 'because' })).toEqual({ state: 'refused', reason: 'because' });
    expect(calls).toEqual([]);
  });
});

describe('LaunchAgent.reconcile', () => {
  it('want on, nothing installed: installs, and reports the job running', async () => {
    const { fsx, agent } = make();
    const p = plan();
    expect(await agent.reconcile(true, p)).toEqual({ state: 'running', pid: 4242 });
    expect(fsx.files.get(p.plistPath)?.data).toBe(p.plist);
  });

  it('want on, a current plist and a loaded job: does nothing', async () => {
    const { fsx, calls, agent } = make({ loaded: true, pid: 600 });
    const p = plan();
    seed(fsx, p);
    expect(await agent.reconcile(true, p)).toEqual({ state: 'running', pid: 600 });
    expect(fsx.writes).toEqual([]);
    expect(calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
  });

  it('want on, a stale plist: rewrites it and loads it again', async () => {
    const { fsx, calls, agent } = make();
    const p = plan();
    seed(fsx, p, { plist: p.plist.replace('<integer>5</integer>', '<integer>10</integer>') });
    expect(await agent.reconcile(true, p)).toEqual({ state: 'running', pid: 4242 });
    expect(fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(calls.map((c) => c[0])).toContain('bootstrap');
  });

  it('want on, a stale wrapper (the app moved): rewrites it', async () => {
    const { fsx, agent } = make({ loaded: true, pid: 600 });
    const moved = plan({ execPath: '/Applications/Elsewhere/Jaffer.app/Contents/MacOS/Jaffer' });
    const old = plan();
    seed(fsx, old);
    await agent.reconcile(true, moved);
    expect(fsx.files.get(moved.wrapperPath)).toEqual({ data: moved.wrapper, mode: 0o755 });
  });

  it('want on, a stale plist but a job that runs: rewrites it and leaves the job (it may be the daemon asking)', async () => {
    const { fsx, calls, agent } = make({ loaded: true, pid: 600 });
    const p = plan();
    seed(fsx, p, { plist: p.plist.replace('<integer>5</integer>', '<integer>10</integer>') });
    expect(await agent.reconcile(true, p)).toEqual({ state: 'running', pid: 600 });
    expect(fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(calls.map((c) => c[0]).filter((v) => v === 'bootout' || v === 'bootstrap')).toEqual([]);
  });

  it('want on, a current plist but a job a person booted out: leaves it that way and says so', async () => {
    const { fsx, calls, agent } = make();
    const p = plan();
    seed(fsx, p);
    expect(await agent.reconcile(true, p)).toEqual({ state: 'not-loaded' });
    expect(calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
  });

  it('want off, a plist present: removes it', async () => {
    const { fsx, calls, agent } = make({ loaded: true, pid: 600 });
    const p = plan();
    seed(fsx, p);
    expect(await agent.reconcile(false, p)).toEqual({ state: 'not-installed' });
    expect(fsx.files.size).toBe(0);
    expect(calls.some((c) => c[0] === 'bootout')).toBe(true);
  });

  it('want off, nothing installed: does nothing at all', async () => {
    const { fsx, calls, agent } = make();
    expect(await agent.reconcile(false, plan())).toEqual({ state: 'not-installed' });
    expect(fsx.writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a refused plan is reported and nothing is touched, whatever is wanted', async () => {
    for (const want of [true, false]) {
      const { fsx, calls, agent } = make({ loaded: true });
      expect(await agent.reconcile(want, { refused: 'move Jaffer to Applications first' })).toEqual({ state: 'refused', reason: 'move Jaffer to Applications first' });
      expect(fsx.files.size + fsx.dirs.size + calls.length).toBe(0);
    }
  });
});

describe('LaunchAgent.kickstart', () => {
  it('runs kickstart on the job and says whether it worked', async () => {
    const up = make({ loaded: true, pid: null });
    expect(await up.agent.kickstart()).toBe(true);
    expect(up.calls).toEqual([['kickstart', TARGET]]);
    const down = make();
    expect(await down.agent.kickstart()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------- helpers

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function withTemp<T>(fn: (dir: string) => T): T {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-agent-')));
  temps.push(dir);
  return fn(dir);
}

// ------------------------------------------------------------------------------------------------- the agent, wired into the product

describe('LaunchAgent for the daemon it runs: loading left to the next start, removal that says what launchd did, files written whole', () => {
  it('install with load: false writes the files and asks launchd nothing (a daemon that is not launchd\'s own never bootstraps)', async () => {
    const { fsx, calls, agent } = make();
    const p = plan();
    await agent.install(p, { load: false });
    expect(fsx.files.get(p.wrapperPath)).toEqual({ data: p.wrapper, mode: 0o755 });
    expect(fsx.files.get(p.plistPath)).toEqual({ data: p.plist, mode: 0o644 });
    expect(calls).toEqual([]);
  });

  it('writes each file whole: under a temporary name in the same folder first, then renamed into place', async () => {
    const { fsx, agent } = make();
    const p = plan();
    await agent.install(p, { load: false });
    const [tmpWrapper, , tmpPlist] = fsx.writes;
    expect(fsx.writes).toEqual([tmpWrapper, p.wrapperPath, tmpPlist, p.plistPath]);
    expect(path.dirname(tmpWrapper!)).toBe(path.dirname(p.wrapperPath));
    expect(path.dirname(tmpPlist!)).toBe(path.dirname(p.plistPath));
    expect(tmpPlist!.endsWith('.plist')).toBe(false); // launchd loads every *.plist in that folder at login: a temporary one must not look like one
    expect([...fsx.files.keys()].sort()).toEqual([p.plistPath, p.wrapperPath].sort()); // nothing temporary is left behind
    // a write that fails half way leaves no cut-off file where launchd looks (it would fail every 5 s), and no temporary one
    const full = memFs();
    const write = full.writeFileSync;
    full.writeFileSync = (f: unknown, data: unknown, o?: unknown) => {
      write(f, String(data).slice(0, 5), o);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const broken = new LaunchAgent({ launchctl: fakeLaunchd().launchctl, uid: 501, fs: full as unknown as LaunchAgentFs });
    await expect(broken.install(p)).rejects.toThrow(/ENOSPC/);
    expect(full.files.size).toBe(0);
  });

  it('remove hands back what the bootout did (its code and what launchctl printed), so Reset and `jaffer service` can say it', async () => {
    const loaded = make({ loaded: true, pid: 4242 });
    seed(loaded.fsx, plan());
    expect(await loaded.agent.remove(plan())).toEqual({ code: 0, out: '' });
    const gone = make();
    expect(await gone.agent.remove(plan())).toEqual({ code: 3, out: 'Boot-out failed: 3: No such process' });
  });

  it('reconcile passes load: false on to install (stale files are rewritten, nothing is bootstrapped)', async () => {
    const { fsx, calls, agent } = make();
    const p = plan();
    seed(fsx, p, { plist: p.plist.replace('<integer>5</integer>', '<integer>10</integer>') });
    expect(await agent.reconcile(true, p, { load: false })).toEqual({ state: 'not-loaded' });
    expect(fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
  });

  it('reconcile(false) of a plan refused for where the app runs (translocated) still takes away an agent installed earlier, through the paths it is given', async () => {
    const { fsx, calls, agent } = make({ loaded: true, pid: null });
    const p = plan();
    seed(fsx, p);
    const refused = planAgent({ ...BASE, execPath: '/private/var/folders/xx/T/AppTranslocation/ABC/d/Jaffer.app/Contents/MacOS/Jaffer' });
    expect(refused).toEqual({ refused: expect.stringMatching(/Applications/) });
    const files = agentFiles({ ...BASE, execPath: '/private/var/folders/xx/T/AppTranslocation/ABC/d/Jaffer.app/Contents/MacOS/Jaffer' });
    expect(files).toEqual(agentPaths(BASE));
    expect(await agent.reconcile(false, refused, { paths: files })).toEqual({ state: 'refused', reason: expect.stringMatching(/Applications/) });
    expect(fsx.files.size).toBe(0);
    expect(calls).toEqual([['bootout', TARGET]]);
    // wanted, a refused plan still installs nothing
    const again = make();
    expect(await again.agent.reconcile(true, refused, { paths: files })).toEqual({ state: 'refused', reason: expect.any(String) });
    expect(again.fsx.writes.length + again.fsx.dirs.size + again.calls.length).toBe(0);
  });

  it('agentFiles: where an agent of this home would be on this Mac, and nothing for another platform or another home', () => {
    expect(agentFiles(BASE)).toEqual(agentPaths(BASE));
    expect(agentFiles({ ...BASE, execPath: '/Volumes/Jaffer 1.2/Jaffer.app/Contents/MacOS/Jaffer' })).toEqual(agentPaths(BASE)); // a refusal about the app, not the home
    expect(agentFiles({ ...BASE, platform: 'linux' })).toBeNull();
    expect(agentFiles({ ...BASE, home: '/tmp/jaffer-test-1/.jaffer' })).toBeNull();
    expect(agentFiles({ ...BASE, userHome: '/Users/m\ne' })).toBeNull();
  });

  it('bootstrap loads the job from its plist and says whether launchd did', async () => {
    const down = make();
    expect(await down.agent.bootstrap(plan().plistPath)).toBe(true);
    expect(down.calls).toEqual([['bootstrap', 'gui/501', plan().plistPath]]);
    const refusing = make({ bootstrapFails: 'Bootstrap failed: 5: Input/output error' });
    expect(await refusing.agent.bootstrap(plan().plistPath)).toBe(false);
  });
});

describe('the wrapper tells the daemon that launchd runs it', () => {
  it('exports JAFFER_LAUNCHD=1 to the app it execs (a detached daemon never has it)', () => {
    expect(plan().wrapper).toContain('export JAFFER_LAUNCHD=1');
    withTemp((dir) => {
      const execPath = path.join(dir, 'Jaffer');
      fs.writeFileSync(execPath, '#!/bin/sh\nprintf "launchd=%s\\n" "$JAFFER_LAUNCHD"\n', { mode: 0o755 });
      fs.chmodSync(execPath, 0o755);
      const wrapper = path.join(dir, 'wrapper.sh');
      fs.writeFileSync(wrapper, plan({ execPath, daemonScript: path.join(dir, 'jafferd.cjs'), uid: 99999 }).wrapper);
      const r = spawnSync('/bin/sh', [wrapper], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('launchd=1');
    });
  });
});

describe('KeepRunning: what the daemon does for the switch (a fake launchd, an in-memory disk)', () => {
  const MOVE = 'Jaffer is running from a disk image or a temporary location. Move Jaffer to Applications first.';
  function keep(o: { launchd?: boolean; plan?: AgentPlan | { refused: string }; files?: AgentFiles | null; start?: Parameters<typeof fakeLaunchd>[0]; keepRunning?: boolean; pid?: number } = {}) {
    const fsx = memFs();
    const d = fakeLaunchd(o.start);
    const agent = new LaunchAgent({ launchctl: d.launchctl, uid: 501, fs: fsx as unknown as LaunchAgentFs });
    const later: { fn: () => unknown; ms: number }[] = [];
    let flag = o.keepRunning ?? false;
    const flags: boolean[] = [];
    const k = new KeepRunning({
      agent,
      plan: () => o.plan ?? plan(),
      files: () => (o.files === undefined ? agentPaths(BASE) : o.files),
      launchd: !!o.launchd,
      ...(o.pid !== undefined ? { pid: o.pid } : {}),
      keepRunning: () => flag,
      setKeepRunning: (on) => {
        flag = on;
        flags.push(on);
      },
      later: (fn, ms) => void later.push({ fn, ms }),
      log: () => undefined,
    });
    return { k, fsx, ...d, later, flags, flag: () => flag };
  }
  const stale = (p: AgentPlan) => ({ plist: p.plist.replace('<integer>5</integer>', '<integer>10</integer>') });

  it('in a daemon that launchd does not run (started detached), install writes the files, loads nothing, turns the switch on, and says it is active from the next login or restart', async () => {
    const t = keep();
    const p = plan();
    const r = await t.k.install();
    expect(r).toEqual({ state: 'installed' });
    expect(agentStatusText(r)).toBe('installed, active from the next login or restart');
    expect(t.fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(t.fsx.files.get(p.wrapperPath)?.data).toBe(p.wrapper);
    expect(t.calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]); // no bootstrap: launchd's instance would find the socket taken and exit 0
    expect(t.flags).toEqual([true]);
  });

  it('in the daemon launchd runs (JAFFER_LAUNCHD=1), install only refreshes the files: launchd is asked to load or stop nothing', async () => {
    const t = keep({ launchd: true, start: { loaded: true, pid: 4242 } });
    const p = plan();
    seed(t.fsx, p, stale(p));
    expect(await t.k.install()).toEqual({ state: 'running', pid: 4242 });
    expect(t.fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(t.calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
    expect(t.flags).toEqual([true]);
  });

  it('in the daemon launchd runs, remove answers first and boots out afterwards (the bootout ends this very daemon), and says the session ends', async () => {
    const t = keep({ launchd: true, start: { loaded: true, pid: 4242 }, keepRunning: true });
    const p = plan();
    seed(t.fsx, p);
    const r = await t.k.remove();
    expect(r.state).toBe('not-installed');
    expect(r.note).toMatch(/session ends/i);
    expect(t.calls).toEqual([]); // nothing yet: the reply has to go out before launchd stops this daemon
    expect(t.flag()).toBe(false);
    expect(t.later).toHaveLength(1);
    expect(t.later[0]!.ms).toBeGreaterThan(0);
    await t.later[0]!.fn();
    expect(t.fsx.files.size).toBe(0);
    expect(t.calls).toEqual([['bootout', TARGET]]);
  });

  it('a normal switch-off in a detached daemon (launchd had nothing loaded) reads "Turned off", not what launchctl printed about a job it never had', async () => {
    const t = keep({ keepRunning: true }); // the job is not loaded: bootout answers "Boot-out failed: 3: No such process"
    seed(t.fsx, plan());
    expect(await t.k.remove()).toEqual({ state: 'not-installed', note: 'Turned off.' });
    expect(t.fsx.files.size).toBe(0);
    // another failure of launchctl is still said
    const odd = keep({ keepRunning: true, start: { loaded: true, pid: null } });
    seed(odd.fsx, plan());
    const run = odd.launchctl.run;
    odd.launchctl.run = async (args) => (args[0] === 'bootout' ? { code: 5, out: 'Boot-out failed: 5: Input/output error\n' } : run(args));
    expect((await odd.k.remove()).note).toMatch(/Input\/output error/);
  });

  it('in a detached daemon, remove takes the files away and boots out at once, and tells what launchd did', async () => {
    const t = keep({ start: { loaded: true, pid: null }, keepRunning: true });
    seed(t.fsx, plan());
    const r = await t.k.remove();
    expect(r.state).toBe('not-installed');
    expect(r.note).toMatch(/launchd/);
    expect(t.fsx.files.size).toBe(0);
    expect(t.calls.filter((c) => c[0] === 'bootout')).toEqual([['bootout', TARGET]]);
    expect(t.later).toEqual([]);
    expect(t.flag()).toBe(false);
  });

  it('status: running with the pid, installed (from the next login or restart) in a detached daemon, not installed', async () => {
    const run = keep({ launchd: true, start: { loaded: true, pid: 31337 } });
    seed(run.fsx, plan());
    expect(await run.k.status()).toEqual({ state: 'running', pid: 31337 });
    const detached = keep({ start: { loaded: true, pid: null } }); // (launchd knows the job, which exited because this daemon has the socket)
    seed(detached.fsx, plan());
    expect(await detached.k.status()).toEqual({ state: 'installed' });
    expect(await keep().k.status()).toEqual({ state: 'not-installed' });
  });

  it("in the daemon launchd runs, status is running with this daemon's pid whatever launchctl print says (no pid line, the job unknown, the plist gone): turning it off ends this session, and the app must ask", async () => {
    for (const start of [{ loaded: true, pid: null }, {}] as const) {
      const t = keep({ launchd: true, start, pid: 31338 });
      seed(t.fsx, plan());
      expect(await t.k.status(), JSON.stringify(start)).toEqual({ state: 'running', pid: 31338 });
    }
    const gone = keep({ launchd: true, pid: 31338 }); // someone deleted the plist; launchd still runs this daemon
    expect(await gone.k.status()).toEqual({ state: 'running', pid: 31338 });
    const refused = keep({ launchd: true, pid: 31338, plan: { refused: 'another home' }, files: null });
    expect(await refused.k.status()).toEqual({ state: 'refused', reason: 'another home' });
  });

  it('in another home (refused), status, install, remove and the start all say why and touch nothing: no file, no launchctl, not the switch', async () => {
    for (const op of ['status', 'install', 'remove', 'reconcileAtStart'] as const) {
      for (const on of [false, true]) {
        const t = keep({ plan: { refused: 'another home' }, files: null, keepRunning: on, start: { loaded: true, pid: 4242 } });
        seed(t.fsx, plan()); // even an agent of the person's own on the same disk is left exactly as it is
        expect(await t.k[op](), op).toEqual({ state: 'refused', reason: 'another home' });
        expect(t.fsx.writes, op).toEqual([]);
        expect(t.fsx.files.size, op).toBe(2);
        expect(t.fsx.dirs.size, op).toBe(0);
        expect(t.calls, op).toEqual([]);
        expect(t.flags, op).toEqual([]);
        expect(t.later, op).toEqual([]);
      }
    }
  });

  it('with the app translocated (refused for where it runs), remove still takes an agent installed earlier away, and install still writes nothing', async () => {
    const t = keep({ plan: { refused: MOVE }, keepRunning: true, start: { loaded: true, pid: null } });
    seed(t.fsx, plan());
    expect(await t.k.install()).toEqual({ state: 'refused', reason: MOVE });
    expect(t.fsx.writes).toEqual([]);
    expect(t.flags).toEqual([]);
    expect(await t.k.remove()).toMatchObject({ state: 'refused', reason: MOVE });
    expect(t.fsx.files.size).toBe(0);
    expect(t.calls.filter((c) => c[0] === 'bootout')).toEqual([['bootout', TARGET]]);
    expect(t.flag()).toBe(false);
  });

  it('at the start of the daemon: on refreshes stale or missing files without loading them; off takes an installed agent away, also when the app is translocated', async () => {
    const p = plan();
    const on = keep({ keepRunning: true });
    seed(on.fsx, p, stale(p));
    expect(await on.k.reconcileAtStart()).toEqual({ state: 'installed' });
    expect(on.fsx.files.get(p.plistPath)?.data).toBe(p.plist);
    expect(on.calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
    const fresh = keep({ keepRunning: true });
    expect(await fresh.k.reconcileAtStart()).toEqual({ state: 'installed' });
    expect(fresh.fsx.files.size).toBe(2);
    expect(fresh.calls.map((c) => c[0]).filter((v) => v !== 'print')).toEqual([]);
    const off = keep({ keepRunning: false, start: { loaded: true, pid: null } });
    seed(off.fsx, p);
    expect(await off.k.reconcileAtStart()).toEqual({ state: 'not-installed' });
    expect(off.fsx.files.size).toBe(0);
    expect(off.calls.some((c) => c[0] === 'bootout')).toBe(true);
    const moved = keep({ keepRunning: false, plan: { refused: MOVE }, start: { loaded: true, pid: null } });
    seed(moved.fsx, p);
    expect(await moved.k.reconcileAtStart()).toEqual({ state: 'refused', reason: MOVE });
    expect(moved.fsx.files.size).toBe(0);
    expect(moved.calls.some((c) => c[0] === 'bootout')).toBe(true);
    // off with nothing installed asks launchd nothing at all (the start of every daemon without the agent)
    const none = keep({ keepRunning: false });
    expect(await none.k.reconcileAtStart()).toEqual({ state: 'not-installed' });
    expect(none.calls).toEqual([]);
    // neither the start nor the switch changes the person's choice by itself
    expect([...on.flags, ...fresh.flags, ...off.flags, ...moved.flags, ...none.flags]).toEqual([]);
  });

  it('the words for each state, as `jaffer service status` and Settings say them', () => {
    expect(agentStatusText({ state: 'not-installed' })).toBe('not installed');
    expect(agentStatusText({ state: 'installed' })).toBe('installed, active from the next login or restart');
    expect(agentStatusText({ state: 'running', pid: 42 })).toBe('running (pid 42)');
    expect(agentStatusText({ state: 'not-loaded' })).toBe('installed but not loaded');
    expect(agentStatusText({ state: 'refused', reason: 'Move Jaffer to Applications first.' })).toBe('refused: Move Jaffer to Applications first.');
  });
});

describe('launchDaemon: launchd starts the daemon when the agent is installed, a detached spawn otherwise', () => {
  function setup(o: { installed?: boolean; start?: Parameters<typeof fakeLaunchd>[0] } = {}) {
    const fsx = memFs();
    const d = fakeLaunchd(o.start);
    const p = plan();
    if (o.installed) seed(fsx, p);
    const agent = daemonAgent({ agent: new LaunchAgent({ launchctl: d.launchctl, uid: 501, fs: fsx as unknown as LaunchAgentFs }), plistPath: p.plistPath, exists: (f) => fsx.files.has(f) });
    const spawned: { cmd: string; args: readonly string[]; opts: { detached?: boolean; env?: NodeJS.ProcessEnv } }[] = [];
    const spawn: NonNullable<Launcher['spawn']> = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref: () => undefined };
    };
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-launch-')));
    temps.push(dir);
    const paths = makePaths(path.join(dir, '.jaffer'));
    const launcher: Launcher = { execPath: '/x/node', daemonScript: path.join(dir, 'jafferd.cjs'), cliScript: path.join(dir, 'jaffer.cjs'), agent, spawn };
    return { fsx, ...d, p, agent, spawned, paths, launcher };
  }

  it('with the agent installed and loaded it kickstarts the job and spawns nothing', async () => {
    const t = setup({ installed: true, start: { loaded: true, pid: null } });
    expect(await launchDaemon(t.paths, t.launcher)).toBe('launchd');
    expect(t.calls).toEqual([['kickstart', TARGET]]);
    expect(t.spawned).toEqual([]);
  });

  it('with the plist on disk but the job not loaded it bootstraps it (RunAtLoad starts the daemon), kickstarts it, and spawns nothing', async () => {
    const t = setup({ installed: true });
    expect(await launchDaemon(t.paths, t.launcher)).toBe('launchd');
    expect(t.calls).toEqual([
      ['kickstart', TARGET],
      ['bootstrap', 'gui/501', t.p.plistPath],
      ['kickstart', TARGET],
    ]);
    expect(t.spawned).toEqual([]);
  });

  it('when launchd will not start it (kickstart and bootstrap fail) it falls back to the detached spawn', async () => {
    const t = setup({ installed: true, start: { bootstrapFails: 'Bootstrap failed: 5: Input/output error' } });
    expect(await launchDaemon(t.paths, t.launcher)).toBe('spawned');
    expect(t.calls.map((c) => c[0])).toEqual(['kickstart', 'bootstrap']);
    expect(t.spawned).toHaveLength(1);
  });

  it('with no agent installed it spawns the daemon detached, as before, and asks launchd nothing', async () => {
    const t = setup();
    expect(await launchDaemon(t.paths, t.launcher)).toBe('spawned');
    expect(t.calls).toEqual([]);
    expect(t.spawned).toHaveLength(1);
    const s = t.spawned[0]!;
    expect(s.cmd).toBe('/x/node');
    expect(s.args).toEqual([t.launcher.daemonScript]);
    expect(s.opts.detached).toBe(true);
    expect(s.opts.env?.JAFFER_HOME).toBe(t.paths.home);
    expect(s.opts.env?.JAFFER_CLI_SCRIPT).toBe(t.launcher.cliScript);
    // and with no agent at all (a test or another home) the same
    const none = setup();
    expect(await launchDaemon(none.paths, { ...none.launcher, agent: null })).toBe('spawned');
    expect(none.spawned).toHaveLength(1);
  });

  it('a detached daemon is never told it is launchd\'s: JAFFER_LAUNCHD is not passed on, from the environment or the launcher', async () => {
    const t = setup();
    const before = process.env.JAFFER_LAUNCHD;
    process.env.JAFFER_LAUNCHD = '1'; // a CLI started from inside a launchd-run session
    try {
      await launchDaemon(t.paths, { ...t.launcher, env: { JAFFER_LAUNCHD: '1' } });
    } finally {
      if (before === undefined) delete process.env.JAFFER_LAUNCHD;
      else process.env.JAFFER_LAUNCHD = before;
    }
    expect(t.spawned[0]!.opts.env?.JAFFER_LAUNCHD).toBeUndefined();
  });

  it('ensureDaemon falls back to the detached spawn when the agent takes itself away (the app it was written for is gone)', async () => {
    const holder: { fsx?: ReturnType<typeof memFs>; plist?: string } = {};
    // launchd starts the wrapper, which finds no app, deletes the plist and exits 0: no daemon comes
    const t = setup({ installed: true, start: { loaded: true, pid: null, onCall: (a) => void (a[0] === 'kickstart' && holder.fsx!.files.delete(holder.plist!)) } });
    holder.fsx = t.fsx;
    holder.plist = t.p.plistPath;
    await expect(ensureDaemon(t.paths, t.launcher, 900)).rejects.toThrow(/Could not start/);
    expect(t.calls[0]).toEqual(['kickstart', TARGET]);
    expect(t.spawned).toHaveLength(1);
  });

  it('ensureDaemon: launchd took the start, but no daemon answers and launchd shows no process for it (one that cannot start, crash-looping or not allowed): after a few seconds it spawns the daemon detached', async () => {
    const t = setup({ installed: true, start: { loaded: true, pid: null } }); // kickstart answers 0, and nothing runs
    const at: number[] = [];
    const spawn = t.launcher.spawn!;
    const t0 = Date.now();
    const launcher: Launcher = { ...t.launcher, launchdGraceMs: 400, spawn: (c, a, o) => (at.push(Date.now() - t0), spawn(c, a, o)) };
    await expect(ensureDaemon(t.paths, launcher, 1800)).rejects.toThrow(/Could not start/); // (no daemon here: only the choice is tested)
    expect(t.calls[0]).toEqual(['kickstart', TARGET]);
    expect(t.calls.some((c) => c[0] === 'print')).toBe(true); // launchd was asked whether it runs one
    expect(t.spawned).toHaveLength(1);
    expect(at[0]).toBeGreaterThanOrEqual(400); // not before launchd had its few seconds
  });

  it('ensureDaemon: while launchd shows a process for the job (a daemon that is still starting) it gets the whole wait, and nothing is spawned beside it', async () => {
    const t = setup({ installed: true, start: { loaded: true, pid: 4242 } });
    await expect(ensureDaemon(t.paths, { ...t.launcher, launchdGraceMs: 300 }, 1500)).rejects.toThrow(/Could not start/);
    expect(t.calls[0]).toEqual(['kickstart', TARGET]);
    expect(t.spawned).toEqual([]);
  });

  it('the agent by default is none for any home but the person\'s own: a test home never runs launchctl', () => {
    expect(defaultDaemonAgent(path.join(os.tmpdir(), 'jaffer-test-x', '.jaffer'))).toBeNull();
  });
});

describe('safety: a development run gets no agent, and the tests can never reach the real launchctl', () => {
  it('planAgent refuses an app run from node_modules (`npm run dev` on ~/.jaffer must never point the real agent at the repo)', () => {
    const execPath = '/Users/me/src/jaffer/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
    expect(planAgent({ ...BASE, execPath })).toEqual({ refused: 'This is a development run of Jaffer: use the installed app.' });
    expect(agentFiles({ ...BASE, execPath })).toEqual(agentPaths(BASE)); // a refusal about the app: an agent installed earlier can still be taken away
  });

  it('JAFFER_NO_LAUNCHCTL=1 makes execLaunchctl fail at once without running anything (checked at each run)', async () => {
    const runs: string[][] = [];
    const fakeExec = ((file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      runs.push([file, ...args]);
      cb(null, '', '');
      return {};
    }) as unknown as typeof execFile;
    const launchctl = execLaunchctl({ execFile: fakeExec });
    const before = process.env.JAFFER_NO_LAUNCHCTL;
    try {
      process.env.JAFFER_NO_LAUNCHCTL = '1';
      expect(await launchctl.run(['bootout', TARGET])).toEqual({ code: 1, out: 'launchctl is disabled (JAFFER_NO_LAUNCHCTL)' });
      expect(runs).toEqual([]);
      delete process.env.JAFFER_NO_LAUNCHCTL; // without it the (here stand-in) launchctl runs
      expect(await launchctl.run(['print', TARGET])).toEqual({ code: 0, out: '' });
      expect(runs).toEqual([['/bin/launchctl', 'print', TARGET]]);
    } finally {
      if (before === undefined) delete process.env.JAFFER_NO_LAUNCHCTL;
      else process.env.JAFFER_NO_LAUNCHCTL = before;
    }
  });

  it('every test run has the kill switch on (vitest.config.ts, vitest.e2e.config.ts), and what the tests spawn inherits it, the daemon too', async () => {
    expect(process.env.JAFFER_NO_LAUNCHCTL).toBe('1');
    for (const config of ['vitest.config.ts', 'vitest.e2e.config.ts']) expect(fs.readFileSync(path.resolve(__dirname, '..', config), 'utf8'), config).toMatch(/JAFFER_NO_LAUNCHCTL: '1'/);
    // a child process, as the tests spawn the bundled CLI and daemon (with process.env, or a copy of it with more in it)
    for (const env of [undefined, { ...process.env, HOME: os.tmpdir() }]) {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.JAFFER_NO_LAUNCHCTL))'], { encoding: 'utf8', env });
      expect(r.stdout).toBe('1');
    }
    // and the daemon as the launcher starts it
    const spawned: { env?: NodeJS.ProcessEnv }[] = [];
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaffer-launch-')));
    temps.push(dir);
    await launchDaemon(makePaths(path.join(dir, '.jaffer')), { execPath: '/x/node', daemonScript: path.join(dir, 'jafferd.cjs'), env: { HOME: dir }, agent: null, spawn: (_c, _a, o) => (spawned.push(o), { unref: () => undefined }) });
    expect(spawned[0]!.env?.JAFFER_NO_LAUNCHCTL).toBe('1');
  });
});
