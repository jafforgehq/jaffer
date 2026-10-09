import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { runInShell, startShell, stopShell, untilReady, waitFor } from './helpers/pty';
import { ForegroundCheck, FOREGROUND_CACHE_MS, FOREGROUND_READ_MS, readForegroundGroup, type PtySession, type PtyEvent } from '../src/core/session/terminal';
import { SessionHost } from '../src/core/session/host';
import { shellChecks } from '../src/core/claude/auto-resume';

let env: TestEnv;
let sh: PtySession | null = null;
beforeEach(() => {
  env = makeEnv();
});
afterEach(async () => {
  if (sh) await stopShell(sh);
  sh = null;
  env.cleanup();
});

type CommandEvent = Extract<PtyEvent, { type: 'command' }>;
const isCmd = (e: PtyEvent): CommandEvent | false => (e.type === 'command' ? e : false);

const SHELLS = ['/bin/bash', '/usr/bin/zsh', '/bin/zsh', '/opt/homebrew/bin/fish'].filter((p, i, a) => fs.existsSync(p) && !p.includes('fish') && a.findIndex((q) => fs.existsSync(q) && path.basename(q) === path.basename(p)) === i);

describe.each(SHELLS)('PtySession with shell integration (%s)', (shell) => {
  it('detects the prompt and captures a typed command with exit code and output', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    expect(sh.integrated).toBe(true);
    const done = waitFor(sh, isCmd);
    sh.write('echo "hello; world"\r');
    const ev = await done;
    expect(ev.cmd).toBe('echo "hello; world"');
    expect(ev.exit).toBe(0);
    expect(ev.output).toBe('hello; world');
  });

  it('reports failing exit codes', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const done = waitFor(sh, isCmd);
    sh.write('ls /definitely/not/here\r');
    const ev = await done;
    expect(ev.exit).not.toBe(0);
    expect(ev.output).toContain('No such file');
  });

  it('tracks the working directory', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const sub = path.join(env.userHome, 'proj dir;x');
    fs.mkdirSync(sub);
    const cwdEvt = waitFor(sh, (e) => (e.type === 'cwd' && e.cwd === sub ? e.cwd : false));
    sh.write(`cd '${sub}'\r`);
    expect(await cwdEvt).toBe(sub);
    expect(sh.cwd).toBe(sub);
  });

  it('carries the shell state from one command to the next, and shows the output on the screen', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    await runInShell(sh, 'export JAFFER_TEST_VAR=carried-over');
    const res = await runInShell(sh, 'echo $JAFFER_TEST_VAR && pwd');
    expect(res.exit).toBe(0);
    expect(res.output).toContain('carried-over');
    expect(res.output).toContain(env.userHome);
    expect(sh.readScreen(10)).toContain('carried-over');
  });

  it('serialises the screen so a late client sees the same content', async () => {
    sh = startShell(env, { shell, cols: 60, rows: 12 });
    await untilReady(sh);
    for (let i = 0; i < 30; i++) {
      sh.write(`echo line-${i}\r`);
      await waitFor(sh, isCmd);
      await untilReady(sh);
    }
    const snap = sh.snapshot();
    const replica = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 5000, allowProposedApi: true });
    await new Promise<void>((r) => replica.write(snap.data, r));
    const text = (t: Terminal) => {
      const b = t.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
      return out.join('\n').trimEnd();
    };
    expect(text(replica)).toContain('line-29');
    expect(text(replica)).toContain('line-0');
    expect(replica.buffer.active.cursorY).toBe(sh.term.buffer.active.cursorY);
    replica.dispose();
  });

  it('keeps bracketed-paste and alt-screen state across a snapshot (needed to restore TUIs)', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    await sh.inject('\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[2J\x1b[Hfull screen app');
    const snap = sh.snapshot();
    expect(snap.alt).toBe(true);
    const replica = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
    await new Promise<void>((r) => replica.write(snap.data, r));
    expect(replica.buffer.active.type).toBe('alternate');
    expect(replica.modes.bracketedPasteMode).toBe(true);
    expect(replica.modes.mouseTrackingMode).not.toBe('none');
    expect(replica.buffer.active.getLine(0)!.translateToString(true)).toContain('full screen app');
    replica.dispose();
  });

  it('surfaces desktop-notification escape sequences (used by Claude Code)', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const n = waitFor(sh, (e) => (e.type === 'notify' ? e : false));
    sh.write(`printf '\\033]9;Claude needs your attention\\007'\r`);
    const e = await n;
    expect(e.type === 'notify' && e.body).toBe('Claude needs your attention');
  });

  it('does not leak daemon-only environment into the shell', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const res = await runInShell(sh, 'echo "[${ELECTRON_RUN_AS_NODE-unset}] [$TERM] [$COLORTERM] [$TERM_PROGRAM] [$JAFFER_SESSION]"');
    expect(res.output).toBe('[unset] [xterm-256color] [truecolor] [Jaffer] [1]');
  });

  // The marks (OSC 133) are output, and any program can print them: a remote shell over ssh with an integration of its own (fish 4,
  // iTerm2's, kitty's) does. What the shell's own prompt is, the terminal's foreground process says: the shell itself, and no program.
  it('the foreground process is the shell only at its own prompt: not while a command, a script of the same shell or a subshell runs, whatever marks they print', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const s = sh;
    /** What foregroundIsShell() says once it has settled (a command takes a moment to be started, and the shell to take the terminal back). */
    const settles = async (want: boolean, ms = 4000) => {
      const t0 = Date.now();
      while (s.foregroundIsShell() !== want && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
      return s.foregroundIsShell();
    };
    expect(await settles(true)).toBe(true);
    // a script of this very shell (its process has the shell's name) that prints what a remote shell prints: its prompt, a command
    // with no command line, its end and the next prompt; then it waits, as ssh would
    const remote = path.join(env.root, 'remote-shell');
    fs.writeFileSync(remote, `#!${shell}\nprintf '\\033]133;D;0\\007\\033]133;A\\007\\033]133;C\\007\\033]133;D;0\\007\\033]133;A\\007'\nsleep 3\n`, { mode: 0o755 });
    let ranNothing = false; // the command with no command line has ended: the prompt after it is the one the script printed
    const forged = waitFor(s, (e) => {
      if (e.type === 'command' && e.cmd === '') ranNothing = true;
      return e.type === 'prompt' && ranNothing;
    });
    s.write(`'${remote}'\r`);
    await forged;
    // the marks say: at a prompt, nothing running; the foreground says otherwise
    expect(s.promptReady).toBe(true);
    expect(s.runningCommand).toBeNull();
    expect(s.foregroundIsShell()).toBe(false); // (what the script printed is output: an answer from before it is not reused)
    expect(s.foregroundIsShell({ fresh: true })).toBe(false);
    expect(await settles(true, 6000)).toBe(true); // it ended: the shell's own prompt
    s.write('sleep 2\r');
    expect(await settles(false)).toBe(false);
    expect(await settles(true, 6000)).toBe(true);
    s.write('( sleep 2; true )\r'); // a subshell: a process of the shell's name, in a group of its own
    expect(await settles(false)).toBe(false);
    expect(await settles(true, 6000)).toBe(true);
    // The shell replaced by another program (`exec`) keeps its pid and its place in the foreground. 0.5.1 drops the comparison of the
    // process's name with the shell's (it hid the Resume button for `SHELL=/bin/sh`, which runs bash, and for any wrapper shell): the
    // terminal's foreground group being the shell's pid is the authority, so this one case now reads as the shell. The marks still say
    // a command runs (`exec sleep 2` began and never ended), so no Resume button shows for it; only a program that prints prompt marks of
    // its own after an `exec` gets one (daemon.test.ts shows it, and that Restart Claude, which types into a new shell, is unaffected).
    s.write('exec sleep 2\r');
    await new Promise((r) => setTimeout(r, 300));
    expect(s.foregroundIsShell({ fresh: true })).toBe(true);
    expect(s.runningCommand).toBe('exec sleep 2');
    await waitFor(s, (e) => e.type === 'exit', 8000);
    expect(s.foregroundIsShell()).toBe(false); // and a shell that is gone is not one either
    expect(s.foregroundIsShell({ fresh: true })).toBe(false);
  }, 40_000);
});

describe('shell integration regressions (found by macOS CI)', () => {
  it('bash: only commands the user typed are recorded, even with user PROMPT_COMMAND hooks from their rc file', async () => {
    // (the test helper starts a non-login shell, which reads ~/.bashrc — where real users put such hooks)
    fs.writeFileSync(path.join(env.userHome, '.bashrc'), "PROMPT_COMMAND='export __user_hook=ran; true'\n");
    sh = startShell(env, { shell: '/bin/bash' });
    const seen: string[] = [];
    sh.events.on((e) => e.type === 'command' && seen.push(e.cmd));
    await untilReady(sh);
    sh.write('echo typed-by-user\r');
    await waitFor(sh, (e) => (e.type === 'command' && e.cmd === 'echo typed-by-user' ? e : false));
    await untilReady(sh);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual(['echo typed-by-user']); // neither startup lines nor the hook itself show up as commands
    expect((await runInShell(sh, 'echo $__user_hook')).output).toBe('ran'); // and the user's own hook still ran
  });

  it('zsh: history stays in the user\'s home, never in the integration shim directory', async () => {
    const zsh = SHELLS.find((s) => s.endsWith('zsh'));
    if (!zsh) return;
    sh = startShell(env, { shell: zsh });
    await untilReady(sh);
    const r = await runInShell(sh, 'print -r -- "$HISTFILE"');
    expect(r.output).toBe(path.join(env.userHome, '.zsh_history'));
    expect(r.output).not.toContain('.jaffer');
  });
});

describe('one session, ever', () => {
  it('runs a single shell, drops extra panes an older version saved, and refuses to start another', async () => {
    const host = new SessionHost(env.paths, env.config, 'test');
    const pane = (id: string) => ({ id, cwd: env.userHome, cols: 100, rows: 30 });
    fs.writeFileSync(env.paths.sessionState, JSON.stringify({ version: 1, startedAt: new Date().toISOString(), savedAt: new Date().toISOString(), panes: [pane('main'), pane('p9x1')] }));
    await host.start();
    try {
      expect(host.list().map((p) => p.id)).toEqual(['main']);
      await expect(host.spawn('p2')).rejects.toThrow(/only one session/);
      expect(host.list()).toHaveLength(1);
      expect('split' in host).toBe(false); // there is no API for it either
    } finally {
      const main = host.get('main');
      host.dispose();
      if (main) await stopShell(main);
    }
  });
});

describe('the one session comes back when its shell dies', () => {
  const lifecycle = (host: SessionHost) => {
    const seen: string[] = [];
    host.events.on((e) => {
      if ('lifecycle' in e) seen.push(e.lifecycle);
    });
    return seen;
  };

  it('starts a fresh shell in the same place when the shell exits', async () => {
    const host = new SessionHost(env.paths, env.config, 'test');
    await host.start();
    const seen = lifecycle(host);
    try {
      const first = host.get('main')!;
      first.write('exit\r');
      await waitUntilTrue(() => seen.includes('restarted'), 8_000);
      const second = host.get('main')!;
      expect(second).not.toBe(first);
      expect(second.alive).toBe(true);
    } finally {
      const main = host.get('main');
      host.dispose();
      if (main) await stopShell(main);
    }
  });

  it('does not respawn in a tight loop when the shell dies at once: each try waits longer', async () => {
    env.config.patch({ shell: { path: '/usr/bin/false', args: [] } });
    const host = new SessionHost(env.paths, env.config, 'test');
    const seen = lifecycle(host);
    await host.start();
    try {
      await new Promise((r) => setTimeout(r, 2000));
      const tries = seen.filter((l) => l === 'spawned' || l === 'restarted').length;
      expect(tries).toBeGreaterThanOrEqual(2); // it does keep trying
      expect(tries).toBeLessThanOrEqual(6); // 13 would be a shell every 150 ms
    } finally {
      host.dispose();
    }
  }, 15_000);
});

async function waitUntilTrue(fn: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('screen restore, and the switch that turns it off', () => {
  const screenOf = (host: SessionHost) => host.get('main')!.snapshot().data;
  const shows = async (host: SessionHost, text: string, ms = 10_000) => {
    const t0 = Date.now();
    while (!screenOf(host).includes(text)) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for "${text}" on the screen`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const stop = async (host: SessionHost) => {
    const main = host.get('main');
    host.dispose();
    if (main) await stopShell(main);
  };

  it('saves the screen and the folder, and a new daemon shows the old screen above a fresh shell in the same folder', async () => {
    const a = new SessionHost(env.paths, env.config, 'test');
    await a.start();
    const folder = path.join(env.userHome, 'restore-here');
    fs.mkdirSync(folder);
    a.get('main')!.write(`cd ${JSON.stringify(folder)} && echo screen-marker-one\r`);
    await shows(a, 'screen-marker-one');
    await new Promise((r) => setTimeout(r, 600)); // the shell integration reports the new folder
    a.persist();
    expect(fs.readFileSync(env.paths.screenSnapshot, 'utf8')).toContain('screen-marker-one');
    await stop(a);
    const b = new SessionHost(env.paths, env.config, 'test');
    await b.start();
    try {
      await shows(b, 'screen-marker-one');
      expect(screenOf(b)).toContain('session restored');
      expect(b.get('main')!.cwd).toBe(fs.realpathSync(folder));
    } finally {
      await stop(b);
    }
  }, 40_000);

  it('with the switch off nothing of the screen is kept: what was saved is removed at once, nothing is written, and a new daemon starts with a blank screen in the same folder', async () => {
    const a = new SessionHost(env.paths, env.config, 'test');
    await a.start();
    const folder = path.join(env.userHome, 'blank-here');
    fs.mkdirSync(folder);
    a.get('main')!.write(`cd ${JSON.stringify(folder)} && echo screen-marker-two\r`);
    await shows(a, 'screen-marker-two');
    await new Promise((r) => setTimeout(r, 600));
    a.persist();
    expect(fs.existsSync(env.paths.screenSnapshot)).toBe(true);
    env.config.patch({ session: { restoreScreen: false } });
    expect(fs.existsSync(env.paths.screenSnapshot)).toBe(false); // gone the moment it is switched off, not at the next save
    a.get('main')!.write('echo more-output-after\r');
    await shows(a, 'more-output-after');
    a.persist();
    expect(fs.existsSync(env.paths.screenSnapshot)).toBe(false); // and it stays gone
    expect(JSON.parse(fs.readFileSync(env.paths.sessionState, 'utf8')).panes[0].cwd).toBe(fs.realpathSync(folder)); // the folder is still kept
    await stop(a);
    const b = new SessionHost(env.paths, env.config, 'test');
    await b.start();
    try {
      await new Promise((r) => setTimeout(r, 1200));
      expect(screenOf(b)).not.toContain('screen-marker-two');
      expect(screenOf(b)).not.toContain('session restored');
      expect(b.get('main')!.cwd).toBe(fs.realpathSync(folder));
      expect(fs.existsSync(env.paths.screenSnapshot)).toBe(false);
    } finally {
      await stop(b);
    }
  }, 40_000);

  it('switching it back on starts saving again', async () => {
    env.config.patch({ session: { restoreScreen: false } });
    const a = new SessionHost(env.paths, env.config, 'test');
    await a.start();
    try {
      expect(fs.existsSync(env.paths.screenSnapshot)).toBe(false);
      env.config.patch({ session: { restoreScreen: true } });
      a.get('main')!.write('echo screen-marker-three\r');
      await shows(a, 'screen-marker-three');
      a.persist();
      expect(fs.readFileSync(env.paths.screenSnapshot, 'utf8')).toContain('screen-marker-three');
    } finally {
      await stop(a);
    }
  }, 40_000);
});

// 0.5.1: the terminal's foreground process group being the shell's own pid is the whole check (the shell's name is no longer compared:
// `SHELL=/bin/sh` runs bash, a wrapper shell has another name, and the Resume button hid for both). The daemon asks about six times per
// command while a conversation is offered, each a synchronous `/bin/ps`: an answer is reused for 250 ms (and not after the terminal
// printed anything), and `ps` gets 500 ms. The moment Restart Claude types always asks again.
describe('the foreground check: the system is asked, at most every 250 ms, and never for long', () => {
  const SHELL_PID = 4242;
  /** A check with a counting group reader and a clock of its own. */
  const check = (o: { group?: () => number | null; alive?: () => boolean } = {}) => {
    let now = 1_000_000;
    const reads: number[] = [];
    const fg = new ForegroundCheck({
      pid: () => SHELL_PID,
      alive: o.alive ?? (() => true),
      readGroup: (pid) => {
        reads.push(pid);
        return o.group ? o.group() : SHELL_PID;
      },
      now: () => now,
    });
    return { fg, reads, advance: (ms: number) => void (now += ms) };
  };

  it('two calls within 250 ms read the group once; the next one after that reads again', () => {
    const t = check();
    expect(t.fg.isShell()).toBe(true);
    t.advance(FOREGROUND_CACHE_MS - 1);
    expect(t.fg.isShell()).toBe(true);
    expect(t.reads).toEqual([SHELL_PID]);
    t.advance(1);
    expect(t.fg.isShell()).toBe(true);
    expect(t.reads).toHaveLength(2);
  });

  it('the answer is as old as the moment its read finished: a `ps` slower than 250 ms is still reused for 250 ms after it ended', () => {
    let now = 1_000_000;
    const reads: number[] = [];
    const fg = new ForegroundCheck({
      pid: () => SHELL_PID,
      alive: () => true,
      readGroup: (pid) => {
        reads.push(pid);
        now += FOREGROUND_CACHE_MS + 100; // a machine under load: the read itself takes longer than the cache lives
        return SHELL_PID;
      },
      now: () => now,
    });
    expect(fg.isShell()).toBe(true);
    now += FOREGROUND_CACHE_MS - 1; // just under 250 ms after the read ended
    expect(fg.isShell()).toBe(true);
    expect(reads).toHaveLength(1); // (stamped before the read, the answer was already older than 250 ms: it read again)
    now += 1; // 250 ms after it ended: asked again
    expect(fg.isShell()).toBe(true);
    expect(reads).toHaveLength(2);
  });

  it('`fresh: true` always reads, and its answer is the one reused afterwards', () => {
    let group: number | null = SHELL_PID;
    const t = check({ group: () => group });
    expect(t.fg.isShell()).toBe(true);
    group = 777; // a program took the terminal a moment later
    t.advance(10);
    expect(t.fg.isShell()).toBe(true); // (a decision may use the answer of 10 ms ago)
    expect(t.fg.isShell({ fresh: true })).toBe(false);
    expect(t.fg.isShell({ fresh: true })).toBe(false);
    expect(t.reads).toHaveLength(3);
    t.advance(10);
    expect(t.fg.isShell()).toBe(false); // the fresh answer is the one reused now
    expect(t.reads).toHaveLength(3);
  });

  it('a reader that throws, or that cannot say in time (null), is "not the shell", and that answer is not kept as a yes', () => {
    let fail: 'throw' | 'null' | null = 'throw';
    const t = check({
      group: () => {
        if (fail === 'throw') throw new Error('ps went away');
        return fail === 'null' ? null : SHELL_PID;
      },
    });
    expect(t.fg.isShell()).toBe(false);
    fail = 'null';
    expect(t.fg.isShell({ fresh: true })).toBe(false);
    fail = null;
    expect(t.fg.isShell({ fresh: true })).toBe(true);
  });

  it('a group that is not the shell\'s pid is not the shell: a command, a script or a program the shell runs has the terminal', () => {
    for (const group of [SHELL_PID + 1, 1, 0, -SHELL_PID]) {
      const t = check({ group: () => group });
      expect(t.fg.isShell(), String(group)).toBe(false);
    }
  });

  it('a pane whose shell is gone is not the shell, and the system is not even asked', () => {
    let alive = true;
    const t = check({ alive: () => alive });
    expect(t.fg.isShell()).toBe(true);
    alive = false;
    expect(t.fg.isShell()).toBe(false); // not the answer of a moment ago either
    expect(t.fg.isShell({ fresh: true })).toBe(false);
    expect(t.reads).toHaveLength(1);
  });

  it('an answer is not reused after the terminal printed something, or once the clock went back', () => {
    const t = check();
    t.fg.isShell();
    t.fg.forget(); // what the pane does for every chunk of output: a program that started prints, and its marks are output
    t.fg.isShell();
    expect(t.reads).toHaveLength(2);
    t.advance(-1000);
    t.fg.isShell();
    expect(t.reads).toHaveLength(3);
  });

  it('the moment Restart Claude types asks the system again, even 1 ms after a decision read it (a cached yes there would type into a program that took the terminal since)', () => {
    let group: number | null = SHELL_PID;
    const t = check({ group: () => group });
    const pane = { alive: true, promptReady: true, foregroundIsShell: (o?: { fresh?: boolean }) => t.fg.isShell(o) };
    const checks = shellChecks(() => pane, () => true);
    expect(checks.promptReady()).toBe(true); // a decision: reads
    t.advance(1);
    expect(checks.promptReady()).toBe(true); // a decision within 250 ms: the same answer, no second read
    expect(t.reads).toHaveLength(1);
    expect(checks.mayType()).toBe(true); // the moment of typing: reads again
    expect(t.reads).toHaveLength(2);
    group = 777; // an ssh (or any program) took the terminal 1 ms later
    t.advance(1);
    expect(checks.mayType()).toBe(false);
    expect(t.reads).toHaveLength(3);
    // and the rest of what they say: no pane, a dead one, a line that is not empty, no prompt
    expect(shellChecks(() => undefined, () => true).mayType()).toBe(false);
    expect(shellChecks(() => ({ ...pane, alive: false }), () => true).mayType()).toBe(false);
    group = SHELL_PID;
    expect(shellChecks(() => pane, () => false).promptReady()).toBe(false);
    expect(shellChecks(() => ({ ...pane, promptReady: false }), () => true).promptReady()).toBe(false);
  });

  it('the real reader: one `ps -o tpgid=` call; a pid that is not there, or a `ps` that hangs, is null within its 500 ms', () => {
    expect(FOREGROUND_READ_MS).toBe(500);
    expect(readForegroundGroup(process.pid)).not.toBe(process.pid); // (this test process does not lead its terminal's foreground, if it has one)
    expect(readForegroundGroup(2 ** 22 + 12345)).toBeNull(); // no such process
    const hang = path.join(env.root, 'ps-that-hangs');
    fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
    const t0 = Date.now();
    expect(readForegroundGroup(process.pid, hang)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a real pane: reads once for calls in a row, again after its shell printed something, and not at all once the shell is gone', async () => {
    const reads: number[] = [];
    sh = startShell(env, { foregroundGroup: (pid) => (reads.push(pid), readForegroundGroup(pid)) });
    await untilReady(sh);
    await new Promise((r) => setTimeout(r, 300)); // (the prompt has been drawn)
    const s = sh;
    const before = reads.length;
    expect(s.foregroundIsShell()).toBe(true);
    expect(s.foregroundIsShell()).toBe(true);
    expect(s.foregroundIsShell()).toBe(true);
    expect(reads.length).toBe(before + 1);
    expect(reads.every((p) => p === s.pid)).toBe(true);
    await runInShell(s, 'echo printed');
    s.foregroundIsShell();
    expect(reads.length).toBe(before + 2);
    s.write('exit\r');
    await waitFor(s, (e) => e.type === 'exit', 8000);
    const gone = reads.length;
    expect(s.foregroundIsShell({ fresh: true })).toBe(false);
    expect(reads.length).toBe(gone);
  }, 20_000);
});

