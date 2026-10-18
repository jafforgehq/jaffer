import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { nextCommand, runInShell, startShell, stopShell, untilReady, waitFor } from './helpers/pty';
import type { PtySession, PtyEvent } from '../src/core/session/terminal';
import { SessionHost } from '../src/core/session/host';

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

/** The terminal's `shellPath` once it is `want` (the mark comes with the prompt; bash's after its PROMPT_COMMAND hooks), or what it is after 5 s. */
async function pathIs(session: PtySession, want: string): Promise<string | undefined> {
  for (let i = 0; i < 100 && session.shellPath !== want; i++) await new Promise((r) => setTimeout(r, 50));
  return session.shellPath;
}

type CommandEvent = Extract<PtyEvent, { type: 'command' }>;
const isCmd = (e: PtyEvent): CommandEvent | false => (e.type === 'command' ? e : false);

const SHELLS = ['/bin/bash', '/usr/bin/zsh', '/bin/zsh', '/opt/homebrew/bin/fish'].filter((p, i, a) => fs.existsSync(p) && !p.includes('fish') && a.findIndex((q) => fs.existsSync(q) && path.basename(q) === path.basename(p)) === i);

describe.each(SHELLS)('PtySession with shell integration (%s)', (shell) => {
  it('detects the prompt and captures a typed command with exit code and output', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    expect(sh.integrated).toBe(true);
    const done = nextCommand(sh);
    sh.write('echo "hello; world"\r');
    const ev = await done;
    expect(ev.cmd).toBe('echo "hello; world"');
    expect(ev.exit).toBe(0);
    expect(ev.output).toBe('hello; world');
  });

  it('reports failing exit codes', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const done = nextCommand(sh);
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
    const s = sh;
    await new Promise<void>((r) => s.term.write('\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[2J\x1b[Hfull screen app', r)); // (into the terminal's own screen, not through the shell)
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

  it('(1.4.2) reports the PATH its startup files made (633;P;Path, with the nonce), again only when it changes; a PATH with control characters or past 8192 characters is ignored', async () => {
    fs.writeFileSync(path.join(env.userHome, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), 'export PATH="/rc/added/bin:$PATH"\n');
    sh = startShell(env, { shell, path: '/usr/bin:/bin' });
    // the PATH marks, counted as the terminal parses them (in step with shellPath and the prompt events; the `data` events come in 4 ms
    // batches, which a fast machine's next command can beat: that read 1 for 2 on Linux CI). Returning false passes the mark on.
    const marks: string[] = [];
    sh.term.parser.registerOscHandler(633, (d) => (d.startsWith('P;Path=') && marks.push(d), false));
    const marksAt = async (want: number) => {
      for (let i = 0; i < 100 && marks.length < want; i++) await new Promise((r) => setTimeout(r, 50));
      return marks.length;
    };
    await untilReady(sh);
    const shown = (await runInShell(sh, 'printf "%s\\n" "$PATH"')).output.replace(/\n/g, '');
    expect(shown).toContain('/rc/added/bin:/usr/bin:/bin');
    expect(await pathIs(sh, shown)).toBe(shown);
    await runInShell(sh, 'true'); // (a prompt's mark is in before the next command starts)
    const n = marks.length;
    expect(n).toBeGreaterThanOrEqual(1);
    await runInShell(sh, 'true');
    expect(marks.length).toBe(n); // (unchanged: not reported again)
    await runInShell(sh, 'export PATH="/later/bin:$PATH"');
    expect(await pathIs(sh, `/later/bin:${shown}`)).toBe(`/later/bin:${shown}`);
    expect(await marksAt(n + 1)).toBe(n + 1);
    await runInShell(sh, 'true');
    expect(marks.length).toBe(n + 1); // (and only one)
    // the nonce never reaches the shell's environment (a program it runs cannot forge the mark with it)
    expect((await runInShell(sh, 'echo "[${JAFFER_NONCE-unset}]"')).output).toBe('[unset]');
    // hostile values are ignored: the last good one stays
    await runInShell(sh, `export PATH="$PATH:/bad$(printf '\\033')x"`);
    await runInShell(sh, 'true');
    expect(sh.shellPath).toBe(`/later/bin:${shown}`);
    await runInShell(sh, `export PATH="/usr/bin:/bin:/$(head -c 9000 /dev/zero | tr '\\0' a)"`);
    await runInShell(sh, 'true');
    expect(sh.shellPath).toBe(`/later/bin:${shown}`);
    // a mark a program prints (no nonce, or a wrong one) is not the shell's
    await runInShell(sh, "printf '\\033]633;P;Path=/forged/bin\\007\\033]633;P;Path=/forged/bin;0000\\007'");
    expect(sh.shellPath).toBe(`/later/bin:${shown}`);
  });

  it('(1.4.2 review) the nonce leaves the environment before the startup files run, and the shell\'s copy of it is never exported, also with allexport', async () => {
    const zsh = shell.endsWith('zsh');
    fs.writeFileSync(path.join(env.userHome, zsh ? '.zshrc' : '.bashrc'), `${zsh ? 'setopt allexport' : 'set -a'}\nenv > "$HOME/rc-env.txt"\n`);
    sh = startShell(env, { shell });
    await untilReady(sh);
    const nonce = (sh as unknown as { nonce: string }).nonce;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(path.join(env.userHome, 'rc-env.txt'), 'utf8')).not.toContain(nonce); // (what the rc file starts does not get it)
    expect((await runInShell(sh, `env | grep -ci -e jaffer_nonce -e ${nonce}`)).output).toBe('0'); // (with set -a, not even a function that names it)
    expect(await pathIs(sh, (await runInShell(sh, 'printf "%s\\n" "$PATH"')).output.replace(/\n/g, ''))).toBeTruthy(); // (and the mark still works)
  });

  it('does not leak daemon-only environment into the shell', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const res = await runInShell(sh, 'echo "[${ELECTRON_RUN_AS_NODE-unset}] [$TERM] [$COLORTERM] [$TERM_PROGRAM] [$JAFFER_SESSION] [$JAFFER_PANE]"');
    expect(res.output).toBe('[unset] [xterm-256color] [truecolor] [Jaffer] [1] [main]'); // (1.4.0: which terminal the shell is, for the Claude in it)
  });
});

describe('shell marks are forgeable at any length', () => {
  it('a forged 8 MB command (633;E) is kept clipped to its head, and so is a forged folder (633;P;Cwd)', async () => {
    const { PtySession: Session } = await import('../src/core/session/terminal');
    const { COMMAND_HEAD } = await import('../src/shared/process-badge');
    const script = "const big = 'a'.repeat(8 * 1024 * 1024); process.stdout.write('\\x1b]133;A\\x07\\x1b]633;E;' + big + '\\x07\\x1b]133;C\\x07done\\r\\n\\x1b]133;D;0\\x07\\x1b]633;P;Cwd=/' + big + '\\x07\\x1b]133;A\\x07'); setTimeout(() => {}, 30000);";
    sh = new Session({ file: process.execPath, args: ['-e', script], cwd: env.root, env: { PATH: process.env.PATH ?? '' }, cols: 80, rows: 24 });
    const cwd = waitFor(sh, (e) => (e.type === 'cwd' ? e : false), 20_000);
    const cmd = await waitFor(sh, isCmd, 20_000);
    expect(cmd.cmd).toHaveLength(4 * COMMAND_HEAD);
    expect((await cwd).cwd.length).toBeLessThanOrEqual(4 * COMMAND_HEAD);
  }, 40_000);
});

describe('(1.4.2) the PATH mark (633;P;Path=<value>;<nonce>) is checked', () => {
  it('(review) only a zsh, bash or fish start gets a nonce: another shell has no integration, so no PATH mark', async () => {
    const { buildShellSpawn } = await import('../src/core/session/shell-integration');
    const spawn = (shell: string) => buildShellSpawn({ shell, paths: env.paths, version: 't', baseEnv: { JAFFER_NONCE: 'from-outside' }, pane: 'main' }).env.JAFFER_NONCE;
    for (const shell of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish']) expect(spawn(shell), shell).toMatch(/^[0-9a-f]{32}$/);
    expect(spawn('/bin/sh')).toBeUndefined();
    expect(spawn('/usr/bin/tcsh')).toBeUndefined();
  });

  it('only with the nonce of the shell Jaffer started, printable (no C0, C1 or DEL), at most 8192 characters; anything else is ignored', async () => {
    const { PtySession: Session } = await import('../src/core/session/terminal');
    const N = 'abc123nonce';
    const marks = [
      ['/no/nonce', ''],
      ['/wrong/nonce', ';nope'],
      ['/ok/one:/usr/bin', `;${N}`],
      ['/nl\\\\x0abin', `;${N}`],
      ['/esc\\\\x1bbin', `;${N}`],
      ['/c1\\\\x85bin', `;${N}`],
      ['/del\\\\x7fbin', `;${N}`],
      [`/${'a'.repeat(8192)}`, `;${N}`],
      ['', `;${N}`],
      ['/semi\\\\x3bok:/x', `;${N}`],
    ];
    const out = marks.map(([v, n]) => `\\x1b]633;P;Path=${v}${n}\\x07\\x1b]133;A\\x07`).join('');
    const script = `process.stdout.write('${out}'); setTimeout(() => {}, 30000);`;
    sh = new Session({ file: process.execPath, args: ['-e', script], cwd: env.root, env: { PATH: process.env.PATH ?? '', JAFFER_NONCE: N }, cols: 80, rows: 24 });
    const seen: (string | undefined)[] = [];
    const s = sh;
    await waitFor(sh, (e) => e.type === 'prompt' && seen.push(s.shellPath) >= marks.length, 20_000);
    expect(seen).toEqual([undefined, undefined, '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/ok/one:/usr/bin', '/semi;ok:/x']);
  }, 40_000);

  it('a terminal started without a nonce takes no PATH mark at all', async () => {
    const { PtySession: Session } = await import('../src/core/session/terminal');
    const script = "process.stdout.write('\\x1b]633;P;Path=/a/bin;\\x07\\x1b]633;P;Path=/a/bin\\x07\\x1b]133;A\\x07'); setTimeout(() => {}, 30000);";
    sh = new Session({ file: process.execPath, args: ['-e', script], cwd: env.root, env: { PATH: process.env.PATH ?? '' }, cols: 80, rows: 24 });
    await waitFor(sh, (e) => e.type === 'prompt', 20_000);
    expect(sh.shellPath).toBeUndefined();
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

  it('bash (1.4.2 review): a PROMPT_COMMAND hook of the rc file that changes PATH (as direnv does) is reported at the same prompt', async () => {
    fs.writeFileSync(path.join(env.userHome, '.bashrc'), `PROMPT_COMMAND='case ":$PATH:" in *:/hook/bin:*) ;; *) PATH="/hook/bin:$PATH";; esac'\n`);
    sh = startShell(env, { shell: '/bin/bash', path: '/usr/bin:/bin' });
    await untilReady(sh);
    const s = sh;
    for (let i = 0; i < 60 && !s.shellPath?.startsWith('/hook/bin:'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(sh.shellPath?.startsWith('/hook/bin:')).toBe(true);
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

// Changed on purpose for 1.4.0 (the spec replaces "one session, ever"): up to four terminals, only by a split, none saved or replayed.
describe('up to four terminals, only by a split', () => {
  const stopAll = async (host: SessionHost) => {
    const all = host.list().map((p) => host.get(p.id)!);
    host.dispose();
    for (const s of all) await stopShell(s);
  };

  it('starts one shell (panes an older version saved are ignored), splits up to four, refuses a fifth, closes any but the last, and reuses a free id', async () => {
    const host = new SessionHost(env.paths, env.config, 'test');
    const pane = (id: string) => ({ id, cwd: env.userHome, cols: 100, rows: 30 });
    fs.mkdirSync(env.paths.sessionDir, { recursive: true });
    fs.writeFileSync(path.join(env.paths.sessionDir, 'state.json'), JSON.stringify({ version: 1, startedAt: new Date().toISOString(), savedAt: new Date().toISOString(), panes: [pane('main'), pane('p9x1')] }));
    const seen: string[] = [];
    host.events.on((e) => 'lifecycle' in e && seen.push(`${e.pane} ${e.lifecycle}`));
    await host.start();
    try {
      expect(host.list().map((p) => p.id)).toEqual(['main']);
      const second = await host.split({ cwd: env.userHome, cols: 90, rows: 20 });
      expect(second).toMatchObject({ id: 'p2', cwd: env.userHome, cols: 90, rows: 20, alive: true });
      await host.split();
      await host.split();
      expect(host.list().map((p) => p.id)).toEqual(['main', 'p2', 'p3', 'p4']);
      await expect(host.split()).rejects.toThrow('At most four terminals.');
      expect(host.list()).toHaveLength(4);
      const p3 = host.get('p3')!;
      const others = ['main', 'p2', 'p4'].map((id) => host.get(id)!.pid);
      host.close('p3');
      expect(seen).toContain('p3 closed');
      expect(host.list().map((p) => p.id)).toEqual(['main', 'p2', 'p4']);
      expect(['main', 'p2', 'p4'].map((id) => host.get(id)!.pid)).toEqual(others); // the others are untouched
      await waitUntilTrue(() => !p3.alive, 5_000);
      await new Promise((r) => setTimeout(r, 600));
      expect(host.get('p3')).toBeUndefined(); // closed for good: not respawned
      expect(seen.filter((l) => l.startsWith('p3 ')).sort()).toEqual(['p3 closed', 'p3 spawned']);
      expect((await host.split()).id).toBe('p3'); // a free id is used again
      for (const id of ['main', 'p2', 'p3']) host.close(id);
      expect(host.list().map((p) => p.id)).toEqual(['p4']);
      expect(() => host.close('p4')).toThrow('Use restart for the last terminal.');
      expect(() => host.close('nope')).toThrow();
      expect(host.list()).toHaveLength(1);
    } finally {
      await stopAll(host);
    }
  }, 40_000);

  it('each shell knows which terminal it is (JAFFER_PANE), the daemon itself does not, and restarting one leaves the others alone', async () => {
    const host = new SessionHost(env.paths, env.config, 'test');
    await host.start();
    const seen: string[] = [];
    host.events.on((e) => 'lifecycle' in e && seen.push(`${e.pane} ${e.lifecycle}`));
    try {
      await host.split();
      for (const id of ['main', 'p2']) {
        const s = host.get(id)!;
        await untilReady(s);
        expect((await runInShell(s, 'echo "[$JAFFER_PANE]"')).output).toBe(`[${id}]`);
      }
      expect(process.env.JAFFER_PANE).toBeUndefined();
      const main = host.get('main')!.pid;
      const p2 = host.get('p2')!;
      await host.restart('p2');
      await waitUntilTrue(() => seen.includes('p2 restarted'), 8_000);
      expect(host.get('p2')).not.toBe(p2);
      expect(host.get('p2')!.alive).toBe(true);
      expect(host.get('main')!.pid).toBe(main);
      // a shell that exits by itself comes back, in any terminal
      host.get('p2')!.write('exit\r');
      await waitUntilTrue(() => seen.filter((l) => l === 'p2 restarted').length === 2, 8_000);
      expect(host.list().map((p) => p.id)).toEqual(['main', 'p2']);
      expect(host.get('main')!.pid).toBe(main);
    } finally {
      await stopAll(host);
    }
  }, 40_000);
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

describe('a plain terminal: nothing of the screen is saved, and a shell that exits is replaced by a fresh one', () => {
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

  it('a new host after the old one stopped starts with a blank screen in the home folder, and reads nothing an older version saved', async () => {
    const a = new SessionHost(env.paths, env.config, 'test');
    await a.start();
    const folder = path.join(env.userHome, 'not-restored');
    fs.mkdirSync(folder);
    a.get('main')!.write(`cd ${JSON.stringify(folder)} && echo screen-marker-one\r`);
    await shows(a, 'screen-marker-one');
    await new Promise((r) => setTimeout(r, 600)); // the shell integration reports the new folder
    await stop(a);
    // what an older version left behind (a saved folder and screen): nothing reads it any more
    fs.mkdirSync(env.paths.sessionDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(env.paths.sessionDir, 'state.json'), JSON.stringify({ version: 1, startedAt: now, savedAt: now, panes: [{ id: 'main', cwd: folder, cols: 100, rows: 30 }] }));
    fs.writeFileSync(path.join(env.paths.sessionDir, 'screen.json'), JSON.stringify({ main: { data: 'screen-marker-old\r\n' } }));
    const b = new SessionHost(env.paths, env.config, 'test');
    await b.start();
    try {
      await new Promise((r) => setTimeout(r, 1200));
      for (const gone of ['screen-marker-one', 'screen-marker-old', 'session restored']) expect(screenOf(b)).not.toContain(gone);
      expect(b.get('main')!.cwd).toBe(fs.realpathSync(os.homedir()));
    } finally {
      await stop(b);
    }
  }, 40_000);

  it('writes nothing of the session to disk: no saved folder and no saved screen, however long it runs', async () => {
    const a = new SessionHost(env.paths, env.config, 'test');
    await a.start();
    try {
      a.get('main')!.write('echo screen-marker-two\r');
      await shows(a, 'screen-marker-two');
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      await stop(a);
    }
    expect(fs.existsSync(env.paths.sessionDir) ? fs.readdirSync(env.paths.sessionDir) : []).toEqual([]);
  }, 40_000);

  it('a shell that exits is replaced by a fresh one in the same folder, with a blank screen', async () => {
    const host = new SessionHost(env.paths, env.config, 'test');
    await host.start();
    const seen: string[] = [];
    host.events.on((e) => {
      if ('lifecycle' in e) seen.push(e.lifecycle);
    });
    try {
      const folder = path.join(env.userHome, 'stays-here');
      fs.mkdirSync(folder);
      const first = host.get('main')!;
      first.write(`cd ${JSON.stringify(folder)} && echo screen-marker-three\r`);
      await shows(host, 'screen-marker-three');
      await waitUntilTrue(() => first.cwd === fs.realpathSync(folder), 8_000);
      first.write('exit\r');
      await waitUntilTrue(() => seen.includes('restarted'), 8_000);
      const second = host.get('main')!;
      expect(second).not.toBe(first);
      expect(second.alive).toBe(true);
      expect(second.cwd).toBe(fs.realpathSync(folder));
      await new Promise((r) => setTimeout(r, 1200));
      for (const gone of ['screen-marker-three', 'session restored']) expect(screenOf(host)).not.toContain(gone);
    } finally {
      await stop(host);
    }
  }, 40_000);
});
