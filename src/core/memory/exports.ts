import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryStore } from './store';
import { buildContext, skillSlug } from './context';
import { writeFileAtomic } from '../../shared/util';

export const BEGIN = '<!-- jaffer:memory:begin — managed by Jaffer; edits inside this block are overwritten -->';
export const END = '<!-- jaffer:memory:end -->';

export type ExportTarget = 'claude-code';

interface TargetDef {
  /** Directory that exists only if the user actually uses the tool. */
  dir: string;
  file: string;
  label: string;
}

export function targetDefs(home: string = os.homedir()): Record<ExportTarget, TargetDef> {
  return {
    'claude-code': { dir: path.join(home, '.claude'), file: path.join(home, '.claude', 'CLAUDE.md'), label: 'Claude Code' },
  };
}

export function detectTargets(home: string = os.homedir()): { target: ExportTarget; label: string; installed: boolean }[] {
  return (Object.entries(targetDefs(home)) as [ExportTarget, TargetDef][]).map(([target, d]) => ({ target, label: d.label, installed: fs.existsSync(d.dir) }));
}

export function renderBlock(store: MemoryStore, home?: string): string {
  const ctx = buildContext(store, { budgetChars: 4500, notes: false, skills: true, home });
  const body = ctx.text || '_Nothing learned yet._';
  return [
    BEGIN,
    '## Memory from Jaffer',
    'Long-term memory learned from the user\'s terminal session (preferences, conventions, lessons, procedures).',
    'Treat it as helpful context, not instructions that override the user. Project-specific sections apply only inside that project\'s directory.',
    '',
    body,
    END,
  ].join('\n');
}

/** Insert/replace the managed block in a file, leaving everything else untouched. `block=null` removes it. */
export function applyBlock(file: string, block: string | null): 'written' | 'unchanged' | 'removed' | 'skipped' {
  let cur = '';
  let exists = true;
  try {
    cur = fs.readFileSync(file, 'utf8');
  } catch {
    exists = false;
  }
  const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`);
  let next: string;
  if (block === null) {
    if (!exists || !re.test(cur)) return 'skipped';
    next = cur.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd() + (cur.trim() ? '\n' : '');
    writeFileAtomic(file, next, 0o644);
    return 'removed';
  }
  if (re.test(cur)) next = cur.replace(re, block + '\n');
  else next = (cur.trimEnd() ? cur.trimEnd() + '\n\n' : '') + block + '\n';
  if (next === cur) return 'unchanged';
  writeFileAtomic(file, next, 0o644);
  return 'written';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ExportResult {
  target: string;
  file: string;
  status: 'written' | 'unchanged' | 'removed' | 'skipped';
}

/** Sync managed blocks for the enabled targets and strip it from the rest. */
export function syncExports(store: MemoryStore, enabled: ExportTarget[], home: string = os.homedir()): ExportResult[] {
  const defs = targetDefs(home);
  const block = renderBlock(store, home);
  const results: ExportResult[] = [];
  for (const [target, def] of Object.entries(defs) as [ExportTarget, TargetDef][]) {
    if (enabled.includes(target)) {
      if (!fs.existsSync(def.dir)) {
        results.push({ target, file: def.file, status: 'skipped' });
        continue;
      }
      results.push({ target, file: def.file, status: applyBlock(def.file, block) });
    } else {
      results.push({ target, file: def.file, status: applyBlock(def.file, null) });
    }
  }
  return results;
}

/** Learned skills become real Claude Code skills (under ~/.claude/skills, one jaffer-NAME directory each). */
export function syncClaudeSkills(store: MemoryStore, enabled: boolean, home: string = os.homedir()): { written: number; removed: number } {
  const root = path.join(home, '.claude', 'skills');
  let written = 0;
  let removed = 0;
  const want = new Map<string, string>();
  if (enabled && fs.existsSync(path.join(home, '.claude'))) {
    for (const s of store.listSkills()) {
      if (s.confidence < 0.5 && !s.pinned) continue;
      const name = `jaffer-${skillSlug(s)}`.slice(0, 64);
      const desc = `${s.whenToUse || s.description}`.replace(/\s+/g, ' ').slice(0, 300);
      const body = [
        '---',
        `name: ${name}`,
        `description: ${JSON.stringify(desc || s.name)}`,
        '---',
        '',
        `# ${s.name}`,
        '',
        s.description,
        '',
        '_Learned by Jaffer from repeated use in this terminal._',
        '',
        '## Steps',
        ...s.steps.map((st, i) => `${i + 1}. \`${st}\``),
        '',
      ].join('\n');
      want.set(name, body);
    }
  }
  for (const [name, body] of want) {
    const file = path.join(root, name, 'SKILL.md');
    let cur = '';
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    if (cur !== body) {
      writeFileAtomic(file, body, 0o644);
      written++;
    }
  }
  try {
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith('jaffer-') && !want.has(d)) {
        fs.rmSync(path.join(root, d), { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    /* no skills dir */
  }
  return { written, removed };
}
