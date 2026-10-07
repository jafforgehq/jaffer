import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers/env';
import { resetJaffer } from '../src/core/reset';
import { installHooks, hooksInstalled } from '../src/core/integrations/claude';
import { applyBlock, BEGIN, END, SKILL_MARKER } from '../src/core/memory/exports';

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

const mk = (p: string, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const claudeEnv = () => ({ ...process.env, HOME: env.userHome, CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude') });

/** A Mac that has been running Jaffer for a while, with the user's own things next to Jaffer's. */
function lived(): { wrapper: string } {
  const wrapper = path.join(env.home, 'bin', 'jaffer');
  mk(path.join(env.home, 'config.json'), '{"onboarded":true}');
  mk(path.join(env.home, 'memory', 'items.json'), '[{"text":"Prefer pnpm"}]');
  mk(wrapper, '#!/bin/sh\n');
  fs.mkdirSync(path.join(env.userHome, '.claude'), { recursive: true });
  installHooks(wrapper, env.userHome);
  const settings = path.join(env.userHome, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo my own hook' }] });
  s.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(s));
  mk(path.join(env.userHome, '.claude', 'CLAUDE.md'), '# My rules\n\nBe brief.\n');
  applyBlock(path.join(env.userHome, '.claude', 'CLAUDE.md'), `${BEGIN}\n- Prefer pnpm\n${END}`);
  mk(path.join(env.userHome, '.claude', 'skills', 'jaffer-release', 'SKILL.md'), `# Release\n\n${SKILL_MARKER}\n`); // one Jaffer published
  mk(path.join(env.userHome, '.claude', 'skills', 'jaffer-handwritten', 'SKILL.md'), '# A skill of the person, whose name starts the same way\n');
  mk(path.join(env.userHome, '.claude', 'skills', 'my-own-skill', 'SKILL.md'));
  fs.mkdirSync(path.join(env.userHome, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(wrapper, path.join(env.userHome, '.local', 'bin', 'jaffer'));
  mk(path.join(env.userHome, 'Library', 'Caches', 'jaffer-updater', 'pending', 'Jaffer.zip'));
  mk(path.join(env.userHome, 'Library', 'Application Support', 'Jaffer', 'Preferences'));
  mk(path.join(env.userHome, 'Library', 'Preferences', 'com.jafforge.jaffer.plist'));
  return { wrapper };
}

describe('resetJaffer', () => {
  it('removes everything Jaffer put on the Mac, keeps what is the user\'s, and keeps a backup of ~/.jaffer', async () => {
    lived();
    const res = await resetJaffer({ home: env.home, userHome: env.userHome, env: claudeEnv(), backup: true, now: new Date('2026-10-07T11:22:33') });
    // Jaffer's own state is moved aside, not destroyed
    expect(fs.existsSync(env.home)).toBe(false);
    expect(res.backupDir).toBe(`${env.home}.backup-20261007-112233`);
    expect(fs.readFileSync(path.join(res.backupDir!, 'config.json'), 'utf8')).toContain('onboarded');
    expect(fs.existsSync(path.join(res.backupDir!, 'memory', 'items.json'))).toBe(true);
    // Claude Code: only Jaffer's hooks go, the person's own hook and settings stay
    const settings = JSON.parse(fs.readFileSync(path.join(env.userHome, '.claude', 'settings.json'), 'utf8'));
    expect(hooksInstalled(env.userHome)).toBe(false);
    expect(JSON.stringify(settings.hooks)).toContain('echo my own hook');
    expect(JSON.stringify(settings.hooks)).not.toMatch(/jaffer/i);
    expect(settings.theme).toBe('dark');
    // what Jaffer wrote into Claude's files
    const md = fs.readFileSync(path.join(env.userHome, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('Be brief.');
    expect(md).not.toContain('Prefer pnpm');
    expect(fs.existsSync(path.join(env.userHome, '.claude', 'skills', 'jaffer-release'))).toBe(false);
    expect(fs.existsSync(path.join(env.userHome, '.claude', 'skills', 'my-own-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(env.userHome, '.claude', 'skills', 'jaffer-handwritten', 'SKILL.md'))).toBe(true); // theirs, though it starts with jaffer-
    // the command-line link, the update cache and the app's own data
    expect(fs.existsSync(path.join(env.userHome, '.local', 'bin', 'jaffer'))).toBe(false);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Caches', 'jaffer-updater'))).toBe(false);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Application Support', 'Jaffer'))).toBe(false);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Preferences', 'com.jafforge.jaffer.plist'))).toBe(false);
    expect(res.messages.join('\n')).toMatch(/backup/i);
  });

  it('can delete instead of keeping a backup', async () => {
    lived();
    const res = await resetJaffer({ home: env.home, userHome: env.userHome, env: claudeEnv(), backup: false });
    expect(fs.existsSync(env.home)).toBe(false);
    expect(res.backupDir).toBeUndefined();
    expect(fs.readdirSync(env.root).filter((n) => n.includes('backup'))).toEqual([]);
  });

  it('leaves the app\'s own data alone when asked (the running app clears it itself)', async () => {
    lived();
    await resetJaffer({ home: env.home, userHome: env.userHome, env: claudeEnv(), backup: true, appData: false });
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Application Support', 'Jaffer', 'Preferences'))).toBe(true);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Caches', 'jaffer-updater'))).toBe(false);
  });

  it('does not touch a jaffer command that is the person\'s own, or any file it does not recognise', async () => {
    lived();
    fs.rmSync(path.join(env.userHome, '.local', 'bin', 'jaffer'));
    mk(path.join(env.userHome, 'mine', 'jaffer'), '#!/bin/sh\n');
    fs.symlinkSync(path.join(env.userHome, 'mine', 'jaffer'), path.join(env.userHome, '.local', 'bin', 'jaffer'));
    mk(path.join(env.userHome, 'Library', 'Caches', 'some-other-app', 'keep.txt'));
    await resetJaffer({ home: env.home, userHome: env.userHome, env: claudeEnv(), backup: true });
    expect(fs.existsSync(path.join(env.userHome, '.local', 'bin', 'jaffer'))).toBe(true);
    expect(fs.existsSync(path.join(env.userHome, 'Library', 'Caches', 'some-other-app', 'keep.txt'))).toBe(true);
  });

  it('refuses a home that is not clearly Jaffer\'s, and touches nothing', async () => {
    lived();
    for (const home of [env.userHome, '/', path.join(env.userHome, 'Documents'), path.dirname(env.userHome)]) {
      await expect(resetJaffer({ home, userHome: env.userHome, env: claudeEnv(), backup: true })).rejects.toThrow(/refus/i);
    }
    expect(fs.existsSync(path.join(env.home, 'config.json'))).toBe(true);
    expect(hooksInstalled(env.userHome)).toBe(true);
  });

  it('refuses a folder with jaffer in its name that is a code checkout or holds none of Jaffer\'s own files (JAFFER_HOME pointing at the wrong place)', async () => {
    lived();
    const checkout = path.join(env.root, 'code', 'jaffer');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"name":"jaffer"}');
    fs.mkdirSync(path.join(checkout, 'memory'), { recursive: true }); // even with a folder that looks like Jaffer's
    const stranger = path.join(env.root, 'documents', 'jaffer-notes');
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stranger, 'todo.txt'), 'buy milk');
    for (const home of [checkout, stranger]) {
      await expect(resetJaffer({ home, userHome: env.userHome, env: claudeEnv(), backup: true })).rejects.toThrow(/refus/i);
      expect(fs.readdirSync(home).length).toBeGreaterThan(0); // nothing was moved
    }
    expect(fs.existsSync(path.join(checkout, 'package.json'))).toBe(true);
    expect(hooksInstalled(env.userHome)).toBe(true); // and nothing outside was touched either
  });

  it('on a Mac that never ran Jaffer there is nothing to do, and that is fine', async () => {
    const res = await resetJaffer({ home: env.home, userHome: env.userHome, env: claudeEnv(), backup: true });
    expect(res.backupDir).toBeUndefined();
    expect(res.messages.join('\n')).toMatch(/nothing/i);
  });
});

describe('jaffer reset (the bundled command)', () => {
  const run = (args: string[], over: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.resolve('dist/cli/jaffer.cjs'), 'reset', ...args], { env: { ...process.env, HOME: env.userHome, JAFFER_HOME: env.home, CLAUDE_CONFIG_DIR: path.join(env.userHome, '.claude'), ...over }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });

  it('does nothing without --yes when nobody can be asked, and says how to confirm', async () => {
    lived();
    const r = await run([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--yes/);
    expect(fs.existsSync(path.join(env.home, 'config.json'))).toBe(true);
  });

  it('with --yes resets, keeps a backup, and tells where it is', async () => {
    lived();
    const r = await run(['--yes']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(env.home)).toBe(false);
    expect(fs.readdirSync(env.root).some((n) => n.startsWith('.jaffer.backup-'))).toBe(true);
    expect(r.out).toMatch(/\.jaffer\.backup-/);
    expect(hooksInstalled(env.userHome)).toBe(false);
  }, 60_000);

  it('--delete removes the backup too', async () => {
    lived();
    const r = await run(['--yes', '--delete']);
    expect(r.code).toBe(0);
    expect(fs.readdirSync(env.root).filter((n) => n.includes('.jaffer'))).toEqual([]);
  }, 60_000);
});
