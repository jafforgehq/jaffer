import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { nextCommand, startShell, stopShell, untilReady } from './helpers/pty';
import type { PtySession } from '../src/core/session/terminal';
import { resumeAction } from '../src/shared/resume-action';

/**
 * What a click on a past conversation types first (1.1.1), in real shells with Jaffer's integration: whatever the person had half typed
 * (the cursor anywhere, or a zsh buffer of several lines from Shift+Enter) goes, and only the line after it runs.
 */
const ID = '01234567-89ab-4cde-8f01-23456789abcd';
const typed = resumeAction({ cwd: '/x' }, { id: ID, cwd: '/x' });
const PREFIX = typed.kind === 'type' ? typed.text.slice(0, typed.text.indexOf('claude --resume')) : '';
const SHELLS = ['/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((p, i, a) => fs.existsSync(p) && a.findIndex((q) => fs.existsSync(q) && path.basename(q) === path.basename(p)) === i);
const LINE = 'echo RESUME-$((2+2))'; // (prints RESUME-4: the echo of the typed line never does)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the prefix a resume types clears what was half typed, in a real shell', () => {
  let env: TestEnv;
  let sh: PtySession | undefined;
  beforeEach(() => void (env = makeEnv()));
  afterEach(async () => {
    if (sh) await stopShell(sh);
    sh = undefined;
    env.cleanup();
  });

  const run = async (shell: string, before: string) => {
    sh = startShell(env, { shell });
    await untilReady(sh);
    if (before) (sh.write(before), await sleep(300));
    const done = nextCommand(sh);
    sh.write(`${PREFIX}${LINE}\r`);
    return done;
  };

  for (const shell of SHELLS) {
    const name = path.basename(shell);
    it(`${name}: an empty line, a half-typed line with the cursor at its end, and with the cursor at its start: only the line runs`, async () => {
      for (const before of ['', 'echo JUNK-$((1+1))', 'echo JUNK-$((1+1))\x01']) {
        const r = await run(shell, before);
        expect(r.cmd, JSON.stringify(before)).toBe(LINE);
        expect(r.output).toContain('RESUME-4');
        expect(r.output).not.toContain('JUNK-2');
        await stopShell(sh!);
        sh = undefined;
      }
    }, 30_000);
  }

  it.skipIf(!SHELLS.some((s) => s.endsWith('zsh')))('zsh: a buffer of several lines (Shift+Enter sends ESC CR) goes whole: the lines above the cursor do not run', async () => {
    const r = await run(SHELLS.find((s) => s.endsWith('zsh'))!, 'echo LINE-ONE-$((1+1))\x1b\recho half');
    expect(r.cmd).toBe(LINE);
    expect(r.output).toContain('RESUME-4');
    expect(r.output).not.toContain('LINE-ONE-2');
  }, 20_000);
});
