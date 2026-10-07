import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderIndex, skillMarkdown, skillSlug, writeViews } from '../src/core/memory/context';
import { MemoryStore } from '../src/core/memory/store';
import { buildDigest, describeMemoryForPrompt } from '../src/core/memory/reflector';
import type { Episode, MemoryItem, SkillItem } from '../src/core/memory/types';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let store: MemoryStore;
beforeEach(() => {
  env = makeEnv();
  store = new MemoryStore(env.paths);
});
afterEach(() => env.cleanup());

const user = () => store.newRun('user');
const skillInput = (name: string) => ({ name, description: `${name}, step by step`, whenToUse: `when asked to ${name.toLowerCase()}`, steps: ['git pull', 'npm test'], scope: 'global' });

describe('MEMORY.md (renderIndex)', () => {
  it('says so when nothing has been learned yet', () => {
    expect(renderIndex(store)).toContain('Nothing learned yet');
  });

  it('groups what is known: global first, then one section per project with its folder shown relative to home, then skills', () => {
    store.add(user(), { kind: 'preference', scope: 'global', text: 'Prefers pnpm over npm for JavaScript projects' });
    const proj = path.join(env.userHome, 'code', 'api');
    store.add(user(), { kind: 'convention', scope: `project:${proj}`, text: 'Handlers live in src/routes, one file per resource' });
    store.addSkill(user(), skillInput('Ship a release'));
    const md = renderIndex(store, env.userHome);
    expect(md.indexOf('## Global')).toBeGreaterThan(-1);
    expect(md.indexOf('## Global')).toBeLessThan(md.indexOf('## Project: api'));
    expect(md.indexOf('## Project: api')).toBeLessThan(md.indexOf('## Skills'));
    expect(md).toContain('_~/code/api_');
    expect(md).toContain('**Preferences**\n- Prefers pnpm over npm for JavaScript projects');
    expect(md).toContain('**Conventions**\n- Handlers live in src/routes, one file per resource');
    expect(md).toContain('- **Ship a release** — when asked to ship a release');
    expect(md).not.toContain(env.userHome); // the person's home folder is not spelled out
  });

  it('leaves archived items out', () => {
    const a = store.add(user(), { kind: 'fact', scope: 'global', text: 'The staging database is reset every night' })!.item;
    store.archive(user(), a.id);
    expect(renderIndex(store)).not.toContain('staging database');
  });
});

describe('skill files', () => {
  const skill = (over: Partial<SkillItem> = {}): SkillItem => ({
    id: 's_ab12cdef01', name: 'Ship a release', description: 'How a release goes out', whenToUse: 'When asked to cut a release', steps: ['npm version patch', 'git push --follow-tags'],
    scope: 'global', confidence: 0.7, evidence: 1, uses: 0, pinned: false, status: 'active', source: 'heuristic', createdAt: '', updatedAt: '', lastSeenAt: '', ...over,
  });

  it('writes a skill as a short markdown page with numbered steps', () => {
    expect(skillMarkdown(skill())).toBe(['# Ship a release', '', 'How a release goes out', '', '**When to use:** When asked to cut a release', '', '## Steps', '1. `npm version patch`', '2. `git push --follow-tags`', ''].join('\n'));
  });

  it('names the file from the skill, safely and uniquely', () => {
    expect(skillSlug(skill())).toBe('ship-a-release-ab12');
    expect(skillSlug(skill({ name: '  Déploiement!! / ../../etc  ' }))).toBe('d-ploiement-etc-ab12');
    expect(skillSlug(skill({ name: '???' }))).toBe('skill-ab12');
    expect(skillSlug(skill({ name: 'x'.repeat(100) })).length).toBeLessThanOrEqual(40 + 5);
    expect(skillSlug(skill())).not.toBe(skillSlug(skill({ id: 's_ffff0000' }))); // two skills with one name do not share a file
    expect(skillSlug(skill({ name: '../../../etc/passwd' }))).not.toContain('/');
  });

  it('keeps MEMORY.md and the skill files in step with the store, removing the file of a skill that is gone', () => {
    const a = store.addSkill(user(), skillInput('Ship a release'))!;
    const runB = user();
    store.addSkill(runB, skillInput('Reset the dev database'));
    writeViews(store, env.userHome);
    const files = () => fs.readdirSync(env.paths.memorySkillsDir).sort();
    expect(files()).toHaveLength(2);
    expect(fs.readFileSync(env.paths.memoryIndex, 'utf8')).toContain('Reset the dev database');
    expect(store.revertRun(runB.runId)).toBe(1); // the person undid the run that learned it
    writeViews(store, env.userHome);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toContain(skillSlug(a));
    expect(fs.readFileSync(env.paths.memoryIndex, 'utf8')).not.toContain('Reset the dev database');
    fs.writeFileSync(path.join(env.paths.memorySkillsDir, 'notes.txt'), 'mine'); // only .md files are Jaffer's to remove
    writeViews(store, env.userHome);
    expect(fs.existsSync(path.join(env.paths.memorySkillsDir, 'notes.txt'))).toBe(true);
  });

  it('does not rewrite a file whose content did not change', () => {
    store.addSkill(user(), skillInput('Ship a release'));
    writeViews(store, env.userHome);
    const stamp = new Date('2020-01-01T00:00:00Z'); // an old time nothing would write by accident
    fs.utimesSync(env.paths.memoryIndex, stamp, stamp);
    writeViews(store, env.userHome);
    expect(Math.round(fs.statSync(env.paths.memoryIndex).mtimeMs / 1000)).toBe(stamp.getTime() / 1000);
    store.addSkill(user(), skillInput('Reset the dev database')); // but real news is written
    writeViews(store, env.userHome);
    expect(fs.statSync(env.paths.memoryIndex).mtimeMs).toBeGreaterThan(stamp.getTime() + 1000);
  });
});

describe('describeMemoryForPrompt', () => {
  const m = (id: string, over: Partial<MemoryItem>): MemoryItem => ({
    id, kind: 'preference', scope: 'global', text: id, tags: [], confidence: 0.6, evidence: 1, uses: 0, contradictions: 0, pinned: false, status: 'active', source: 'user',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), ...over,
  });

  it('lists the strongest first with their id, kind, scope, confidence, evidence and pin, so a model can refer to them', () => {
    const out = describeMemoryForPrompt([m('weak', { confidence: 0.2 }), m('strong', { confidence: 0.9, evidence: 5, pinned: true, scope: 'project:/work/api', kind: 'convention' })]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('strong [convention | project:/work/api | c=0.90 n=5 | pinned] strong');
    expect(lines[1]).toBe('weak [preference | global | c=0.20 n=1] weak');
  });

  it('cuts the list at the limit', () => {
    const items = Array.from({ length: 10 }, (_, i) => m(`item${i}`, { confidence: 0.5 + i / 100 }));
    expect(describeMemoryForPrompt(items, 3).split('\n')).toHaveLength(3);
    expect(describeMemoryForPrompt([])).toBe('');
  });
});

describe('buildDigest', () => {
  let n = 0;
  const base = (ts: string) => ({ seq: ++n, id: `e${n}`, ts });
  const cmd = (ts: string, c: string, exit: number | null, over: Partial<Extract<Episode, { t: 'cmd' }>> = {}): Episode => ({ ...base(ts), t: 'cmd', cmd: c, exit, ...over });
  const ext = (ts: string, role: 'user' | 'assistant', text: string, over: Partial<Extract<Episode, { t: 'ext' }>> = {}): Episode => ({ ...base(ts), t: 'ext', agent: 'claude-code', role, text, ...over });
  const note = (ts: string, text: string): Episode => ({ ...base(ts), t: 'note', text });

  it('writes one line per event with the time, the project folder and what happened', () => {
    const d = buildDigest([
      cmd('2026-10-07T09:15:00Z', 'npm test', 0, { project: '/work/api' }),
      cmd('2026-10-07T09:16:00Z', 'npm run build', 2, { cwd: '/work/web', out: 'error TS2304:\n  cannot find   name' }),
      ext('2026-10-07T09:17:00Z', 'user', 'no, use pnpm here', { correction: true, cwd: '/work/api' }),
      ext('2026-10-07T09:18:00Z', 'assistant', 'Switching to pnpm.'),
      note('2026-10-07T09:19:00Z', 'remember the staging url is internal'),
    ]).split('\n');
    expect(d).toEqual([
      '[10-07 09:15] (api) $ npm test → ok',
      '[10-07 09:16] (web) $ npm run build → exit 2',
      '    output tail: error TS2304: cannot find name',
      '[10-07 09:17] (api) claude-code USER [CORRECTION]: no, use pnpm here',
      '[10-07 09:18] (-) claude-code ASSISTANT: Switching to pnpm.',
      '[10-07 09:19] (-) NOTE FROM USER: remember the staging url is internal',
    ]);
  });

  it('cuts long commands, output and messages so one event cannot fill the prompt', () => {
    const d = buildDigest([cmd('2026-10-07T09:15:00Z', 'x'.repeat(500), 1, { out: 'y'.repeat(900) }), ext('2026-10-07T09:16:00Z', 'user', 'z'.repeat(2000))]);
    for (const l of d.split('\n')) expect(l.length).toBeLessThan(450);
    expect(d).toContain('…');
  });

  it('when it is too long, drops the least interesting lines first and keeps the rest in time order', () => {
    const eps: Episode[] = [
      cmd('2026-10-07T09:00:00Z', 'ls', 0), // plain success: first to go
      cmd('2026-10-07T09:01:00Z', 'npm test', 1), // a failure
      ext('2026-10-07T09:02:00Z', 'assistant', 'ok'),
      ext('2026-10-07T09:03:00Z', 'user', 'no, use pnpm', { correction: true }), // a correction: last to go
      note('2026-10-07T09:04:00Z', 'a note from the person'),
    ];
    const full = buildDigest(eps).length;
    const kept = buildDigest(eps, full - 5).split('\n');
    expect(kept.some((l) => l.includes('$ ls'))).toBe(false);
    expect(kept.some((l) => l.includes('CORRECTION'))).toBe(true);
    const tight = buildDigest(eps, 120).split('\n');
    expect(tight.some((l) => l.includes('NOTE FROM USER'))).toBe(true);
    expect(tight.some((l) => l.includes('CORRECTION'))).toBe(true);
    expect(tight.some((l) => l.includes('$ ls'))).toBe(false);
    const times = tight.map((l) => l.slice(1, 12));
    expect([...times].sort()).toEqual(times); // still chronological
  });

  it('is empty for no events', () => {
    expect(buildDigest([])).toBe('');
  });
});
