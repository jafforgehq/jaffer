import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock, BEGIN, END, removeClaudeSkills, syncClaudeSkills } from '../src/core/memory/exports';
import { MemoryStore } from '../src/core/memory/store';
import { writeFileAtomic } from '../src/shared/util';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const claudeDir = () => path.join(env.userHome, '.claude');
const skillsDir = () => path.join(claudeDir(), 'skills');

describe('the block in the user’s own CLAUDE.md', () => {
  const file = () => path.join(claudeDir(), 'CLAUDE.md');
  beforeEach(() => fs.mkdirSync(claudeDir(), { recursive: true }));

  it('is replaced as written, whatever characters the memory text holds (JavaScript treats $& $` $\' $$ in a replacement as patterns)', () => {
    fs.writeFileSync(file(), `# My rules\n\n${BEGIN}\nold\n${END}\n\n## Mine, after the block\nKeep this.\n`);
    const tricky = ["- Quote tabs with grep -P $'\\t' and $& and $` and $$ in scripts", '- price is $$5 and ${HOME}'];
    expect(applyBlock(file(), `${BEGIN}\n${tricky.join('\n')}\n${END}`)).toBe('written');
    const out = fs.readFileSync(file(), 'utf8');
    for (const line of tricky) expect(out).toContain(line);
    expect(out).toContain('# My rules');
    expect(out.endsWith('## Mine, after the block\nKeep this.\n')).toBe(true);
    expect(out.match(/Keep this\./g)).toHaveLength(1); // nothing of the user's text was pulled into the block
    expect(applyBlock(file(), `${BEGIN}\n${tricky.join('\n')}\n${END}`)).toBe('unchanged');
  });

  it('writes through a symlink (a dotfiles manager) instead of replacing it, and keeps the file’s own permissions', () => {
    const real = path.join(env.root, 'dotfiles', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '# Mine\n', { mode: 0o600 });
    fs.symlinkSync(real, file());
    expect(applyBlock(file(), `${BEGIN}\nhello\n${END}`)).toBe('written');
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true); // still a link
    expect(fs.readFileSync(real, 'utf8')).toContain('hello');
    expect(fs.statSync(real).mode & 0o777).toBe(0o600); // not widened to 0644
    expect(applyBlock(file(), null)).toBe('removed');
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('# Mine\n');
  });
});

describe('writeFileAtomic', () => {
  it('can follow a link and keep the mode of a file that is already there', () => {
    const real = path.join(env.root, 'real.txt');
    const link = path.join(env.root, 'link.txt');
    fs.writeFileSync(real, 'a', { mode: 0o640 });
    fs.symlinkSync(real, link);
    writeFileAtomic(link, 'b', 0o600, { preserve: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('b');
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    // without the option, Jaffer’s own files are written as asked
    writeFileAtomic(real, 'c', 0o600);
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    // and a file that is not there yet gets the mode asked for
    writeFileAtomic(path.join(env.root, 'new.txt'), 'x', 0o644, { preserve: true });
    expect(fs.statSync(path.join(env.root, 'new.txt')).mode & 0o777).toBe(0o644);
  });
});

describe('skills Jaffer published to Claude Code', () => {
  const publishOne = () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    const store = new MemoryStore(env.paths);
    store.addSkill(store.newRun('heuristic'), { name: 'Ship a release', description: 'How a release goes out', whenToUse: 'When asked to release', steps: ['npm version patch', 'git push'], scope: 'global', confidence: 0.8 });
    expect(syncClaudeSkills(store, true, env.userHome).written).toBe(1);
    return store;
  };

  it('are taken back when publishing is switched off, but a skill of the user’s own that happens to be called jaffer-something is not touched', () => {
    const store = publishOne();
    const mine = path.join(skillsDir(), 'jaffer-my-own-notes');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: jaffer-my-own-notes\ndescription: "how I work on Jaffer"\n---\n\nHand-written, nothing to do with the app.\n');
    const bare = path.join(skillsDir(), 'jaffer-without-skill-file');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'notes.txt'), 'mine too');
    expect(fs.readdirSync(skillsDir()).filter((d) => d.startsWith('jaffer-'))).toHaveLength(3);

    expect(syncClaudeSkills(store, false, env.userHome).removed).toBe(1); // only the one Jaffer wrote
    expect(fs.readdirSync(skillsDir()).sort()).toEqual(['jaffer-my-own-notes', 'jaffer-without-skill-file']);
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toContain('Hand-written');
    expect(fs.readFileSync(path.join(bare, 'notes.txt'), 'utf8')).toBe('mine too');
  });

  it('also only its own on reset', () => {
    publishOne();
    const mine = path.join(skillsDir(), 'jaffer-mine');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'My own.\n');
    expect(removeClaudeSkills(env.userHome)).toBe(1);
    expect(fs.readdirSync(skillsDir())).toEqual(['jaffer-mine']);
  });

  it('a skill whose steps no longer qualify is removed on the next sync, and the published ones are not rewritten when nothing changed', () => {
    const store = publishOne();
    expect(syncClaudeSkills(store, true, env.userHome)).toEqual({ written: 0, removed: 0 });
  });
});
