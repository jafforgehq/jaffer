import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caffeinateHold, isDefaultHome, spawnHold } from '../src/core/session/caffeinate';
import { isInteractiveCommand, StayAwake, type Work } from '../src/core/session/stay-awake';
import { STAY_AWAKE } from '../src/shared/keep-running';
import { makeEnv, type TestEnv } from './helpers/env';

/** A fake clock and fake timers, as in finished-notifier.test.ts: nothing here waits for real time. */
let now = 1_000_000;
let timers: { fn: () => void; at: number; id: number; live: boolean }[] = [];
const advance = (ms: number) => {
  const to = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    now = due.at;
    due.live = false;
    due.fn();
  }
  now = to;
};

/** Every hold the controller asked for, and whether it was let go. */
let holds: { args: string[]; released: boolean }[] = [];
let holdFails = false;
let releaseFails = false;
const PID = 4242;
const ARGS = ['-i', '-w', String(PID)];

const make = (platform = 'darwin') =>
  new StayAwake({
    platform,
    pid: PID,
    hold: (args) => {
      if (holdFails) throw new Error('no caffeinate');
      const h = { args, released: false };
      holds.push(h);
      return {
        release: () => {
          h.released = true;
          if (releaseFails) throw new Error('already gone');
        },
      };
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers[id as number];
      if (t) t.live = false;
    },
  });

const none: Work = { enabled: true, claude: false, command: null };
const working: Work = { enabled: true, claude: true, command: null };
const running = (cmd: string, ago = 0): Work => ({ enabled: true, claude: false, command: { cmd, since: now - ago } });
const active = () => holds.filter((h) => !h.released).length;

let sa: StayAwake;
beforeEach(() => {
  now = 1_000_000;
  timers = [];
  holds = [];
  holdFails = false;
  releaseFails = false;
  sa = make();
});

describe('StayAwake: Claude working', () => {
  it('starts exactly one hold, for the daemon (caffeinate -i -w <pid>), and a second update does not start another', () => {
    sa.update(working);
    expect(sa.holding).toBe(true);
    expect(holds.map((h) => h.args)).toEqual([ARGS]);
    sa.update(working);
    sa.update({ ...working, command: { cmd: 'make', since: now - 60_000 } }); // a command on top of Claude: still the one hold
    expect(holds).toHaveLength(1);
    expect(active()).toBe(1);
  });

  it('holds nothing while nothing works', () => {
    sa.update(none);
    expect(sa.holding).toBe(false);
    expect(holds).toHaveLength(0);
  });

  it('lets go 15 s after the work stops, and not before', () => {
    sa.update(working);
    sa.update(none);
    advance(STAY_AWAKE.releaseDelayMs - 1);
    expect(sa.holding).toBe(true);
    expect(active()).toBe(1);
    advance(1);
    expect(sa.holding).toBe(false);
    expect(holds[0]!.released).toBe(true);
  });

  it('does not flap: idle for 10 s and working again neither releases nor starts another', () => {
    sa.update(working);
    sa.update(none);
    advance(10_000);
    sa.update(working);
    advance(60_000); // far past where the first delay would have ended
    expect(holds).toHaveLength(1);
    expect(holds[0]!.released).toBe(false);
    expect(sa.holding).toBe(true);
    // and the delay starts over from the next time the work stops
    sa.update(none);
    advance(STAY_AWAKE.releaseDelayMs - 1);
    expect(sa.holding).toBe(true);
    advance(1);
    expect(sa.holding).toBe(false);
  });

  it('asks for a new hold after a release, and never has two at once', () => {
    sa.update(working);
    sa.update(none);
    advance(STAY_AWAKE.releaseDelayMs);
    expect(active()).toBe(0);
    sa.update(working);
    sa.update(working);
    expect(holds).toHaveLength(2);
    expect(active()).toBe(1);
  });

  it('a waiting Claude (the daemon passes claude: false for needs-you) is not work', () => {
    sa.update({ enabled: true, claude: false, command: null });
    advance(STAY_AWAKE.commandCapMs);
    expect(holds).toHaveLength(0);
  });

  it('is not capped: a working Claude keeps the hold for as long as it works', () => {
    sa.update(working);
    for (let i = 0; i < 30; i++) {
      advance(STAY_AWAKE.commandCapMs / 10);
      sa.update(working);
    }
    expect(holds).toHaveLength(1);
    expect(holds[0]!.released).toBe(false);
    expect(sa.holding).toBe(true);
  });
});

describe('StayAwake: the switch, stopping, the platform and failures', () => {
  it('enabled: false releases at once, also while the delay of a release is running', () => {
    sa.update(working);
    sa.update({ ...working, enabled: false });
    expect(sa.holding).toBe(false);
    expect(holds[0]!.released).toBe(true);
    sa.update(working);
    sa.update(none);
    sa.update({ ...none, enabled: false }); // the delay was running: off does not wait for it
    expect(sa.holding).toBe(false);
    expect(active()).toBe(0);
  });

  it('while it is off no work holds anything; on again with work holds again', () => {
    sa.update({ ...working, enabled: false });
    sa.update({ ...running('make', 60_000), enabled: false });
    expect(holds).toHaveLength(0);
    sa.update(working);
    expect(sa.holding).toBe(true);
  });

  it('stop() releases at once and nothing holds after it', () => {
    sa.update(working);
    sa.stop();
    expect(sa.holding).toBe(false);
    expect(holds[0]!.released).toBe(true);
    sa.update(working);
    expect(holds).toHaveLength(1);
    expect(timers.filter((t) => t.live)).toHaveLength(0);
  });

  it('stop() also ends the delay of a release that was running, and can be called twice', () => {
    sa.update(working);
    sa.update(none);
    sa.stop();
    sa.stop();
    expect(holds[0]!.released).toBe(true);
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    expect(() => advance(60_000)).not.toThrow();
    expect(holds).toHaveLength(1);
  });

  it('a platform other than darwin never holds', () => {
    for (const platform of ['linux', 'win32', 'freebsd', '']) {
      const other = make(platform);
      other.update(working);
      other.update(running('make', 60_000));
      expect(other.holding, platform).toBe(false);
    }
    expect(holds).toHaveLength(0);
  });

  it('hold throwing leaves it not holding and does not throw out of update; the next update tries again', () => {
    holdFails = true;
    expect(() => sa.update(working)).not.toThrow();
    expect(sa.holding).toBe(false);
    expect(holds).toHaveLength(0);
    holdFails = false;
    sa.update(working);
    expect(sa.holding).toBe(true);
    expect(holds).toHaveLength(1);
  });

  it('a release that throws is still a release, and does not throw out of update, the timer or stop', () => {
    releaseFails = true;
    sa.update(working);
    expect(() => sa.update({ ...working, enabled: false })).not.toThrow();
    expect(sa.holding).toBe(false);
    sa.update(working);
    sa.update(none);
    expect(() => advance(STAY_AWAKE.releaseDelayMs)).not.toThrow();
    expect(sa.holding).toBe(false);
    sa.update(working);
    expect(() => sa.stop()).not.toThrow();
    expect(sa.holding).toBe(false);
  });
});

// 0.5.1: `caffeinate` can end by itself (killed by someone, crashed): the controller hears it (`onExit`) and holds again while the work
// goes on, waiting 1 s, then 2 s, 4 s ... up to 30 s between tries, and from 1 s again after a hold that lasted a minute. A hold that
// cannot even start is logged once.
describe('StayAwake: a hold that ends by itself', () => {
  /** Holds that can end by themselves (`exit()`), or fail to start (`spawnError`), as the real one reports it through onExit. */
  let live: { args: string[]; released: boolean; exit: (error?: Error) => void; exited: boolean }[] = [];
  let logs: string[] = [];
  const makeDying = () =>
    new StayAwake({
      platform: 'darwin',
      pid: PID,
      hold: (args) => {
        let cb: ((error?: Error) => void) | undefined;
        const h = {
          args,
          released: false,
          exited: false,
          exit: (error?: Error) => {
            h.exited = true;
            cb?.(error);
          },
        };
        live.push(h);
        return {
          release: () => {
            h.released = true;
            if (h.exited) return; // a dead hold: nothing to let go of, and no harm
          },
          onExit: (fn) => void (cb = fn),
        };
      },
      log: (m) => void logs.push(m),
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms, id: timers.length, live: true };
        timers.push(t);
        return t.id;
      },
      clearTimer: (id) => {
        const t = timers[id as number];
        if (t) t.live = false;
      },
    });
  let d: StayAwake;
  beforeEach(() => {
    live = [];
    logs = [];
    d = makeDying();
  });

  it('a hold that ends while the work goes on is held again after 1 s, and the next one that ends after 2 s', () => {
    d.update(working);
    expect(live).toHaveLength(1);
    advance(5_000);
    live[0]!.exit();
    expect(d.holding).toBe(false);
    d.update(working); // the work goes on: an update in the wait does not hold at once (a hold that keeps dying must not spin)
    advance(999);
    expect(live).toHaveLength(1);
    advance(1);
    expect(live).toHaveLength(2);
    expect(d.holding).toBe(true);
    expect(live[1]!.args).toEqual(ARGS);
    live[1]!.exit(); // at once again
    advance(1_999);
    expect(live).toHaveLength(2);
    advance(1);
    expect(live).toHaveLength(3);
    live[2]!.exit();
    advance(4_000);
    expect(live).toHaveLength(4);
  });

  it('the wait doubles up to 30 s, and a hold that lasted a minute starts it over at 1 s', () => {
    d.update(working);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = now;
      live.at(-1)!.exit();
      const n = live.length;
      for (let k = 0; k < 600 && live.length === n; k++) advance(100); // (bounded: a minute at most)
      waits.push(now - before);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    advance(60_000); // a clean minute
    const before = now;
    live.at(-1)!.exit();
    const n = live.length;
    for (let k = 0; k < 600 && live.length === n; k++) advance(100);
    expect(now - before).toBe(1_000);
  });

  it('no hold again after stop(), or once the work stopped, or with the switch off', () => {
    d.update(working);
    live[0]!.exit();
    d.stop();
    advance(60_000);
    expect(live).toHaveLength(1);
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    // the work stopped during the wait
    const w = makeDying();
    w.update(working);
    live.at(-1)!.exit();
    const n = live.length;
    w.update(none);
    advance(60_000);
    expect(live).toHaveLength(n);
    expect(w.holding).toBe(false);
    // the switch turned off during the wait
    const s = makeDying();
    s.update(working);
    live.at(-1)!.exit();
    const m = live.length;
    s.update({ ...working, enabled: false });
    advance(60_000);
    expect(live).toHaveLength(m);
    // a hold that ends during the delay of a release (the work had stopped) is not held again either
    const r = makeDying();
    r.update(working);
    r.update(none);
    advance(5_000);
    live.at(-1)!.exit();
    const k = live.length;
    advance(60_000);
    expect(live).toHaveLength(k);
    expect(r.holding).toBe(false);
  });

  it('a hold let go of on purpose is not "ended by itself": its exit afterwards starts nothing', () => {
    d.update(working);
    d.update({ ...working, enabled: false }); // released
    live[0]!.exit(); // (the real caffeinate reports its exit after the kill)
    d.update({ ...working, enabled: false });
    advance(60_000);
    expect(live).toHaveLength(1);
    // and after a release by its delay, the same
    d.update(working);
    d.update(none);
    advance(STAY_AWAKE.releaseDelayMs);
    live[1]!.exit();
    advance(60_000);
    expect(live).toHaveLength(2);
  });

  it('release() of a hold that is already dead is harmless, wherever it comes from (the switch, the delay, stop)', () => {
    d.update(working);
    live[0]!.exit();
    advance(1_000); // held again
    live[1]!.exited = true; // dead, and its exit not heard yet
    expect(() => d.update({ ...working, enabled: false })).not.toThrow();
    expect(live[1]!.released).toBe(true);
    expect(() => d.stop()).not.toThrow();
  });

  it('a hold that cannot start (a spawn error) is logged once, however often it is tried', () => {
    d.update(working);
    live[0]!.exit(Object.assign(new Error('spawn /usr/bin/caffeinate ENOENT'), { code: 'ENOENT' }));
    for (let i = 0; i < 6; i++) {
      advance(30_000);
      live.at(-1)!.exit(Object.assign(new Error('spawn /usr/bin/caffeinate ENOENT'), { code: 'ENOENT' }));
    }
    expect(live.length).toBeGreaterThan(5); // it kept trying, with its waits
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/ENOENT/);
    // hold() itself throwing is the same news, told once by a controller (and each try is still made at the next update)
    const t = new StayAwake({ platform: 'darwin', pid: PID, hold: () => { throw new Error('EAGAIN'); }, log: (m) => void logs.push(m), now: () => now, setTimer: () => 0, clearTimer: () => undefined });
    t.update(working);
    t.update(working);
    t.update(working);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/EAGAIN/);
  });
});

describe('StayAwake: a command that runs a long time', () => {
  it('holds only once it has run 30 s', () => {
    sa.update(running('npm run build'));
    expect(sa.holding).toBe(false);
    advance(STAY_AWAKE.commandAfterMs - 1);
    sa.update({ enabled: true, claude: false, command: { cmd: 'npm run build', since: now - (STAY_AWAKE.commandAfterMs - 1) } });
    expect(sa.holding).toBe(false);
    advance(1);
    sa.update({ enabled: true, claude: false, command: { cmd: 'npm run build', since: now - STAY_AWAKE.commandAfterMs } });
    expect(sa.holding).toBe(true);
    expect(holds.map((h) => h.args)).toEqual([ARGS]);
  });

  it('lets go 15 s after the command ends', () => {
    sa.update(running('make', 45_000));
    expect(sa.holding).toBe(true);
    sa.update(none);
    advance(STAY_AWAKE.releaseDelayMs - 1);
    expect(sa.holding).toBe(true);
    advance(1);
    expect(sa.holding).toBe(false);
  });

  it('never holds for an interactive program, however long it runs', () => {
    for (const cmd of ['ssh host', 'mosh me@host', 'vim x', 'nvim', 'vi notes.txt', 'less log', 'man ls', 'top', 'htop', 'tmux', 'screen', 'watch -n 5 date', 'tail -f log', 'claude', 'claude --resume abcdef12']) {
      sa.update(running(cmd, 3 * 3_600_000));
      expect(sa.holding, cmd).toBe(false);
    }
    expect(holds).toHaveLength(0);
  });

  it('is capped at six hours: the command-only hold is released then, and not asked for again', () => {
    const cmd = 'npm run build';
    const at = (ago: number): Work => ({ enabled: true, claude: false, command: { cmd, since: now - ago } });
    const since = now;
    advance(STAY_AWAKE.commandAfterMs);
    sa.update(at(now - since));
    expect(sa.holding).toBe(true);
    advance(STAY_AWAKE.commandCapMs - STAY_AWAKE.commandAfterMs - 1);
    sa.update(at(now - since));
    expect(now - since).toBe(STAY_AWAKE.commandCapMs - 1);
    expect(sa.holding).toBe(true);
    advance(1);
    sa.update(at(now - since)); // six hours: now, not after the delay of a release
    expect(sa.holding).toBe(false);
    expect(holds[0]!.released).toBe(true);
    advance(60_000);
    sa.update(at(now - since));
    expect(holds).toHaveLength(1);
  });

  it('a working Claude is not capped even when the command beside it is', () => {
    sa.update({ enabled: true, claude: true, command: { cmd: 'make', since: now - STAY_AWAKE.commandCapMs - 1000 } });
    expect(sa.holding).toBe(true);
    advance(STAY_AWAKE.commandCapMs);
    sa.update({ enabled: true, claude: true, command: { cmd: 'make', since: now - 2 * STAY_AWAKE.commandCapMs } });
    expect(sa.holding).toBe(true);
    expect(holds).toHaveLength(1);
  });
});

describe('isInteractiveCommand', () => {
  it('knows the programs a person sits in', () => {
    for (const cmd of ['ssh host', 'ssh -p 2222 me@host', 'mosh me@host', 'vim x', 'nvim', 'vi notes.txt', 'less log', 'man ls', 'top', 'htop', 'tmux', 'tmux attach -t work', 'screen -r', 'watch -n 5 date', 'claude', 'claude --resume abcdef12', '  ssh   host  ']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(true);
    }
  });

  it('sees through a path, variables and the usual wrappers', () => {
    for (const cmd of ['/usr/bin/ssh host', './vim x', 'EDITOR=vi ssh host', 'FOO=1 BAR=2 less x', 'sudo vim /etc/hosts', 'sudo -E vim x', 'command ssh host', 'env FOO=1 htop', 'time ssh host', 'nice top', 'exec tmux', 'nohup claude']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(true);
    }
  });

  it('skips the options of sudo, env, nice, time and nohup and their values (the tables sshHost uses) before it looks at the program', () => {
    for (const cmd of ['sudo -u deploy vim', 'nice -n 10 top', 'env -u FOO ssh host', 'sudo -iu deploy ssh h', 'time -p vim', 'sudo -u deploy -- vim x', 'env -i PATH=/bin less x', 'sudo -g staff env FOO=1 nice -n 5 htop', 'nohup nice -n 19 tmux', 'sudo -Hu deploy -E vim x', 'sudo --user=deploy vim']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['sudo -u deploy make', 'nice -n 10 make', 'env -u FOO make', 'sudo -iu deploy ./build.sh', 'time -p npm test', 'sudo -u vim make', 'nice -n top make', 'env -u ssh make']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
  });

  it('reads a crafted line of a megabyte of wrapper options in a blink too', () => {
    for (const line of ['sudo -u ' + 'a'.repeat(1_000_000), 'nice ' + '-n 5 '.repeat(200_000) + 'top', 'env ' + '-uX '.repeat(250_000) + 'vim', 'sudo ' + '-'.repeat(1_000_000), 'time ' + '-p '.repeat(330_000) + 'vim', 'env ' + 'A=1 -u B '.repeat(110_000)]) {
      const t0 = performance.now();
      isInteractiveCommand(line);
      expect(performance.now() - t0, line.slice(0, 20)).toBeLessThan(100);
    }
  });

  it('knows tail only when it follows', () => {
    for (const cmd of ['tail -f log', 'tail -F log', 'tail -n 50 -f log', 'tail -fn 20 log', 'tail -fn20 log', 'tail --follow log', 'tail --follow=name log', 'tail -f -n 5 a b', '/usr/bin/tail -f x']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['tail log', 'tail -n 50 log', 'tail -20 log', 'tail -c 100 log', 'tail --lines=5 log']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
  });

  it('sees a program after a pipe, a list or a cd', () => {
    for (const cmd of ['git log | less', 'cd src && vim x', 'cd ~; ssh host', 'make 2>&1 | tail -f out', 'ls || htop']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(true);
    }
  });

  it('is false for everything else, and for a program that only has such a name in it', () => {
    for (const cmd of ['', '   ', 'npm test', 'make -j8', 'git log', 'sleep 60', 'echo vim', 'cat vimrc', 'grep -r ssh .', './vim.sh', 'topology', 'sshd', 'viewer', 'manage.py runserver', 'lessc a.less', 'cd screen', 'python train.py --watch', 'claudette', 'docker compose up', 'FOO=ssh make']) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
  });

  it('reads a crafted line of a megabyte in a blink (only the start of it is read, in one pass)', () => {
    const lines = [
      'a '.repeat(500_000),
      ' '.repeat(1_000_000) + 'ssh host',
      '|'.repeat(1_000_000),
      'FOO=1 '.repeat(170_000),
      'sudo '.repeat(200_000) + 'vim',
      'tail ' + '-n '.repeat(330_000) + '-f',
      ('x'.repeat(100) + ' ').repeat(10_000),
      '\\'.repeat(1_000_000),
      '"'.repeat(1_000_000),
    ];
    for (const line of lines) {
      const t0 = performance.now();
      isInteractiveCommand(line);
      expect(performance.now() - t0, line.slice(0, 20)).toBeLessThan(100);
    }
  });

  it('reads only the start of a line: a program after 4096 characters is not looked for', () => {
    expect(isInteractiveCommand(`${'a'.repeat(5000)} | vim`)).toBe(false);
    expect(isInteractiveCommand(`vim ${'a'.repeat(5000)}`)).toBe(true);
  });
});

/** The real hold is never run here: `hold` of a home that holds for real is not called, only what decides which kind it is. */
describe('which hold a daemon gets (caffeinate itself is never run by a test)', () => {
  let env: TestEnv;
  const home = process.env.HOME;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    env.cleanup();
  });

  it('with a test log, nothing is run: every hold and release is a line of JSON in the file, and the platform is macOS wherever the test runs', () => {
    const file = path.join(env.root, 'hold.log');
    const { platform, hold } = caffeinateHold(env.home, { JAFFER_TEST_HOLD_LOG: file });
    expect(platform).toBe('darwin');
    const h = hold(['-i', '-w', '77']);
    h.release();
    hold(['-i', '-w', '78']).release();
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([
      { op: 'hold', args: ['-i', '-w', '77'] },
      { op: 'release', args: ['-i', '-w', '77'] },
      { op: 'hold', args: ['-i', '-w', '78'] },
      { op: 'release', args: ['-i', '-w', '78'] },
    ]);
  });

  it('the real hold reports its end through onExit (a harmless program runs in place of caffeinate), also a program that cannot start; letting go of a dead one is harmless', async () => {
    const quick = spawnHold('/bin/sh', ['-c', 'exit 0']);
    expect(await new Promise<unknown>((resolve) => quick.onExit!((e) => resolve(e ?? 'ended')))).toBe('ended');
    expect(() => quick.release()).not.toThrow();
    expect(await new Promise<unknown>((resolve) => quick.onExit!((e) => resolve(e ?? 'heard late')))).toBe('heard late'); // asked after the end: still told
    const missing = spawnHold(path.join(env.root, 'no-such-caffeinate'), ['-i']);
    expect(String(await new Promise<unknown>((resolve) => missing.onExit!((e) => resolve(e))))).toMatch(/ENOENT/);
    expect(() => missing.release()).not.toThrow();
    const long = spawnHold('/bin/sleep', ['30']);
    const ended = new Promise<unknown>((resolve) => long.onExit!((e) => resolve(e ?? 'ended')));
    long.release(); // killed: its end is reported too (the controller knows it let go of it)
    expect(await ended).toBe('ended');
    expect(() => long.release()).not.toThrow();
  });

  it('a home that is not the default one (a test, a second install) never holds: its platform is none', () => {
    expect(isDefaultHome(env.home)).toBe(false);
    expect(caffeinateHold(env.home, {}).platform).not.toBe('darwin');
    expect(caffeinateHold(env.home, {}).platform).not.toBe(process.platform);
    const other = new StayAwake({ ...caffeinateHold(env.home, {}), pid: 1, now: () => 0, setTimer: () => 0, clearTimer: () => undefined });
    other.update(working);
    expect(other.holding).toBe(false);
  });

  it('only ~/.jaffer of the user the system knows is the default home, whatever HOME says', () => {
    const real = os.userInfo().homedir;
    process.env.HOME = real;
    expect(isDefaultHome(path.join(real, '.jaffer'))).toBe(true);
    expect(isDefaultHome(path.join(real, '.jaffer-other'))).toBe(false);
    expect(isDefaultHome(path.join(env.userHome, '.jaffer'))).toBe(false);
    expect(caffeinateHold(path.join(real, '.jaffer'), {}).platform).toBe(process.platform); // (not called: that would run caffeinate)
    // a HOME that is a temporary folder (a test's) makes its own ~/.jaffer no more the person's
    process.env.HOME = env.userHome;
    expect(isDefaultHome(path.join(env.userHome, '.jaffer'))).toBe(false);
    expect(isDefaultHome(path.join(real, '.jaffer'))).toBe(false);
  });
});
