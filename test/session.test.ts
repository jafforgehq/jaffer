import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { startShell, untilReady, waitFor } from './helpers/pty';
import type { PtySession, PtyEvent } from '../src/core/session/terminal';
import { RunRefused } from '../src/core/session/terminal';

let env: TestEnv;
let sh: PtySession | null = null;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  sh?.dispose();
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
    expect(ev.by).toBe('user');
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

  it('lets the agent run a command in the live shell and read its output', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    sh.write('export JAFFER_TEST_VAR=carried-over\r');
    await waitFor(sh, isCmd);
    await untilReady(sh);
    const res = await sh.runCommand('echo $JAFFER_TEST_VAR && pwd');
    expect(res.exit).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain('carried-over'); // shell state is shared with the user's session
    expect(res.output).toContain(env.userHome);
    // and it is visible on the screen the user watches
    expect(sh.readScreen(10)).toContain('carried-over');
  });

  it('tags agent commands as such and serialises concurrent runs', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const events: CommandEvent[] = [];
    sh.events.on((e) => {
      if (e.type === 'command') events.push(e);
    });
    const [a, b] = await Promise.all([sh.runCommand('echo one'), sh.runCommand('echo two')]);
    expect(a.output).toBe('one');
    expect(b.output).toBe('two');
    expect(events.map((e) => e.by)).toEqual(['agent', 'agent']);
  });

  it('refuses to inject while a command is running and times out long ones without killing them', async () => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    const slow = await sh.runCommand('sleep 2; echo late', { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    await expect(sh.runCommand('echo nope')).rejects.toBeInstanceOf(RunRefused);
    await waitFor(sh, isCmd, 5000);
    await untilReady(sh);
    expect((await sh.runCommand('echo after')).output).toBe('after');
  });

  it('an Escape the user pressed at the prompt does not eat the first byte of the next agent command', async () => {
    // bash treats a pending \e as a Meta prefix, so "echo" used to arrive as "cho" (found by the Claude Code UI test)
    sh = startShell(env, { shell, cols: 40 });
    await untilReady(sh);
    sh.write('\x1b');
    await new Promise((r) => setTimeout(r, 1200));
    const r = await sh.runCommand('echo survived-the-escape');
    expect(r.output).toBe('survived-the-escape');
    expect(r.exit).toBe(0);
    sh.write('\x1b\x1b');
    await new Promise((r2) => setTimeout(r2, 300));
    expect((await sh.runCommand('echo and-twice')).output).toBe('and-twice');
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
    await expect(sh.runCommand('echo x')).rejects.toBeInstanceOf(RunRefused);
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
    const res = await sh.runCommand('echo "[${ELECTRON_RUN_AS_NODE-unset}] [$TERM] [$COLORTERM] [$TERM_PROGRAM] [$JAFFER_SESSION]"');
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
    expect((await sh.runCommand('echo $__user_hook')).output).toBe('ran'); // and the user's own hook still ran
  });

  it('zsh: history stays in the user\'s home, never in the integration shim directory', async () => {
    const zsh = SHELLS.find((s) => s.endsWith('zsh'));
    if (!zsh) return;
    sh = startShell(env, { shell: zsh });
    await untilReady(sh);
    const r = await sh.runCommand('print -r -- "$HISTFILE"');
    expect(r.output).toBe(path.join(env.userHome, '.zsh_history'));
    expect(r.output).not.toContain('.jaffer');
  });
});
