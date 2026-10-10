import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BEGIN, END, removeClaudeBlock, removeJafferSkills, SKILL_MARKER } from '../src/core/integrations/legacy-claude';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

const claudeMd = () => path.join(env.userHome, '.claude', 'CLAUDE.md');
const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
/** The block as Jaffer's memory wrote it (exports.ts before 0.6.0). */
const block = `${BEGIN}\n## Memory from Jaffer\n- Prefer pnpm; quote tabs with $'\\t' and $& and $\`\n${END}`;

describe('the markers', () => {
  it('are the exact text old versions wrote, em dash included (a block they wrote must still be found)', () => {
    expect(BEGIN).toBe('<!-- jaffer:memory:begin — managed by Jaffer; edits inside this block are overwritten -->');
    expect(END).toBe('<!-- jaffer:memory:end -->');
    expect(SKILL_MARKER).toBe('_Learned by Jaffer from repeated use in this terminal._');
  });
});

describe('removeClaudeBlock', () => {
  it('removes the block between BEGIN and END, and keeps the text before and after it byte for byte', () => {
    const before = '# My rules\n\nBe brief.\n\n';
    const after = '## Mine, after the block\nKeep this.  \n\n\n';
    write(claudeMd(), `${before}${block}\n${after}`);
    expect(removeClaudeBlock(claudeMd())).toBe(true);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(before + after);
  });

  it('keeps a file written with Windows line ends as it was, around the block', () => {
    write(claudeMd(), `first\r\n${BEGIN}\r\nx\r\n${END}\r\nlast\r\n`);
    expect(removeClaudeBlock(claudeMd())).toBe(true);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe('first\r\nlast\r\n');
  });

  it('deletes a file that held nothing but the block (Jaffer made it)', () => {
    write(claudeMd(), `${block}\n`);
    expect(removeClaudeBlock(claudeMd())).toBe(true);
    expect(fs.existsSync(claudeMd())).toBe(false);
  });

  it('leaves alone a file without the block, a block that never ends, and a file that is not there', () => {
    const mine = '# Mine\n\n<!-- jaffer:memory:end -->\nno block here\n';
    write(claudeMd(), mine);
    expect(removeClaudeBlock(claudeMd())).toBe(false);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(mine);
    const open = `# Mine\n${BEGIN}\nnever closed\n`;
    write(claudeMd(), open);
    expect(removeClaudeBlock(claudeMd())).toBe(false);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(open);
    expect(removeClaudeBlock(path.join(env.userHome, '.codex', 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(env.userHome, '.codex'))).toBe(false); // nothing is made
  });

  it('writes through a symlink (a dotfiles manager) instead of replacing it, and keeps the file’s own permissions', () => {
    const real = path.join(env.root, 'dotfiles', 'CLAUDE.md');
    write(real, `# Mine\n\n${block}\n`, 0o600);
    fs.chmodSync(real, 0o600);
    fs.mkdirSync(path.dirname(claudeMd()), { recursive: true });
    fs.symlinkSync(real, claudeMd());
    expect(removeClaudeBlock(claudeMd())).toBe(true);
    expect(fs.lstatSync(claudeMd()).isSymbolicLink()).toBe(true); // still a link
    expect(fs.readFileSync(real, 'utf8')).toBe('# Mine\n\n');
    expect(fs.statSync(real).mode & 0o777).toBe(0o600); // not widened to 0644
    // a link to a file that held only the block stays a link: its target is emptied, not the link deleted
    fs.writeFileSync(real, `${block}\n`);
    expect(removeClaudeBlock(claudeMd())).toBe(true);
    expect(fs.lstatSync(claudeMd()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('');
  });
});

describe('removeJafferSkills', () => {
  const skills = () => path.join(env.userHome, '.claude', 'skills');

  it('removes the jaffer-* skills that carry Jaffer’s marker, and leaves the person’s own (whatever they are called)', () => {
    write(path.join(skills(), 'jaffer-release', 'SKILL.md'), `---\nname: jaffer-release\n---\n\n# Release\n\n${SKILL_MARKER}\n`);
    write(path.join(skills(), 'jaffer-release', 'notes.txt'), 'part of it');
    write(path.join(skills(), 'jaffer-deploy', 'SKILL.md'), `# Deploy\n\n${SKILL_MARKER}\n`);
    write(path.join(skills(), 'jaffer-handwritten', 'SKILL.md'), '# A skill of the person, whose name starts the same way\n');
    write(path.join(skills(), 'jaffer-without-skill-file', 'notes.txt'), 'mine too');
    write(path.join(skills(), 'my-own-skill', 'SKILL.md'), `# Mine, quoting the line\n\n${SKILL_MARKER}\n`);
    expect(removeJafferSkills(skills())).toBe(2);
    expect(fs.readdirSync(skills()).sort()).toEqual(['jaffer-handwritten', 'jaffer-without-skill-file', 'my-own-skill']);
    expect(fs.readFileSync(path.join(skills(), 'jaffer-handwritten', 'SKILL.md'), 'utf8')).toContain('of the person');
    expect(removeJafferSkills(skills())).toBe(0); // a second time there is nothing left to do
  });

  it('is fine with no skills folder at all', () => {
    expect(removeJafferSkills(skills())).toBe(0);
    expect(fs.existsSync(skills())).toBe(false);
  });
});
