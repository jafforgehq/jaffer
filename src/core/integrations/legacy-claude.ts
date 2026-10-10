import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../shared/util';

/**
 * What Jaffer's memory (before 0.6.0) wrote into Claude Code's own files, and how to take it back: the marked block in a global
 * instructions file (`~/.claude/CLAUDE.md`; the first builds also wrote it to `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`) and the
 * skills it published (`~/.claude/skills/jaffer-*`). Used by Reset and by the first start of an upgraded Mac. Only Jaffer's own
 * entries are touched: the markers below are the exact text old versions wrote (an em dash included), so they must never change.
 */
export const BEGIN = '<!-- jaffer:memory:begin — managed by Jaffer; edits inside this block are overwritten -->';
export const END = '<!-- jaffer:memory:end -->';

/** The line every skill Jaffer published carries: how Jaffer tells its own skills from a `jaffer-…` directory of the person's. */
export const SKILL_MARKER = '_Learned by Jaffer from repeated use in this terminal._';

/**
 * The instructions files of two other agents that the first builds (2026-10-06) also wrote the block into, under the person's home.
 * Only the block is ever taken out of them (`removeClaudeBlock`); a file without it is not touched.
 */
export function firstDayBlockFiles(userHome: string): string[] {
  return [path.join(userHome, '.codex', 'AGENTS.md'), path.join(userHome, '.gemini', 'GEMINI.md')];
}

/** The block (from BEGIN to the first END after it) and the line break that ends it. Bounded: indexOf, no regular expression. */
function withoutBlocks(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf(BEGIN, from);
    if (start < 0) break;
    const end = text.indexOf(END, start + BEGIN.length);
    if (end < 0) break; // a block that does not end is not one Jaffer wrote: left as it is
    let after = end + END.length;
    if (text.startsWith('\r\n', after)) after += 2;
    else if (text.startsWith('\n', after)) after += 1;
    out += text.slice(from, start);
    from = after;
  }
  return out + text.slice(from);
}

/**
 * Removes Jaffer's marked block from `file`, and leaves everything else in it as it was, byte for byte. A file that held nothing but
 * the block is deleted (a link to it is left alone, and its target is emptied instead). A file through a link is written through it,
 * with its own permissions. Returns whether a block was there; a file that is missing, unreadable or without the block is untouched.
 */
export function removeClaudeBlock(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const rest = withoutBlocks(text);
  if (rest === text) return false;
  if (rest === '' && !fs.lstatSync(file).isSymbolicLink()) fs.rmSync(file, { force: true });
  else writeFileAtomic(file, rest, 0o644, { preserve: true });
  return true;
}

/**
 * Removes the skills Jaffer published from a Claude Code skills folder: a `jaffer-*` directory whose `SKILL.md` carries Jaffer's
 * marker. The person's own (a `jaffer-…` name without the marker, or without a `SKILL.md`) stay. Returns how many went.
 */
export function removeJafferSkills(skillsDir: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(skillsDir);
  } catch {
    return 0; // no skills folder
  }
  for (const name of names) {
    if (!name.startsWith('jaffer-')) continue;
    const dir = path.join(skillsDir, name);
    let ours = false;
    try {
      ours = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes(SKILL_MARKER);
    } catch {
      /* no SKILL.md: not one of Jaffer's */
    }
    if (!ours) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
