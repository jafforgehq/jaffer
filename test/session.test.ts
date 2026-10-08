import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { runInShell, startShell, stopShell, untilReady, waitFor } from './helpers/pty';
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

