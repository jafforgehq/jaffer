import { execFileSync } from 'node:child_process';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { runInShell, startShell, stopShell, untilReady } from './helpers/pty';
import type { PtySession } from '../src/core/session/terminal';

function hasClaude(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CLAUDE = hasClaude();

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

async function until(fn: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`condition not met in ${ms}ms; screen:\n${sh?.readScreen(30)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Claude Code is the primary workload for this terminal; these run whenever it is installed.
describe.skipIf(!CLAUDE)('Claude Code inside a Jaffer session', () => {
  it('starts the real TUI, which draws and accepts input', async () => {
    sh = startShell(env, { shell: '/bin/bash', cols: 120, rows: 36 });
    await untilReady(sh);
    sh.write('claude\r');
    await until(() => /Claude Code/.test(sh!.readScreen(40)));
    expect(sh.runningCommand).toBe('claude');
    // The TUI is driven by the same keystrokes a user sends: arrow down changes the highlighted choice.
    const before = sh.readScreen(40);
    sh.write('\x1b[B');
    await new Promise((r) => setTimeout(r, 500));
    expect(sh.readScreen(40)).not.toBe(before);
  }, 60_000);

  it('survives a client detaching and re-attaching mid-session (the TUI is restored from a snapshot)', async () => {
    sh = startShell(env, { shell: '/bin/bash', cols: 120, rows: 36 });
    await untilReady(sh);
    sh.write('claude\r');
    await until(() => /Let's get started|Welcome to Claude Code/.test(sh!.readScreen(40)));
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await sh.consistentSnapshot();
    const liveCursorY = sh.term.buffer.active.cursorY; // read in the same tick: the TUI may redraw while the replica parses
    const replica = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 5000, allowProposedApi: true });
    await new Promise<void>((r) => replica.write(snap.data, r));
    const b = replica.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true));
    const text = lines.join('\n');
    expect(text).toMatch(/Welcome to Claude Code|Let's get started/);
    // Same cursor row => Ink's relative cursor movement keeps working after restore.
    expect(replica.buffer.active.cursorY).toBe(liveCursorY);
    replica.dispose();
  }, 60_000);

  it('the shell is still usable afterwards', async () => {
    sh = startShell(env, { shell: '/bin/bash' });
    await untilReady(sh);
    const v = await runInShell(sh, 'claude --version');
    expect(v.output).toMatch(/Claude Code/);
    expect(v.exit).toBe(0);
  });
});
