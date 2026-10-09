import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchAgent, agentPaths, planAgent, type AgentPlan, type Launchctl, type LaunchAgentFs, type PlanInput } from '../src/core/service/launch-agent';
import { AGENT_LABEL } from '../src/shared/keep-running';

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
    await expect(agent.remove(plan())).resolves.toBeUndefined();
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
