import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOps } from '../src/core/memory/apply';
import { MemoryStore } from '../src/core/memory/store';
import type { ProposedOp } from '../src/core/memory/types';
import { makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let store: MemoryStore;
beforeEach(() => {
  env = makeEnv();
  store = new MemoryStore(env.paths);
});
afterEach(() => env.cleanup());

const seed = (text: string, opts: { pinned?: boolean; scope?: string } = {}) => {
  const r = store.add(store.newRun('user'), { kind: 'preference', scope: opts.scope ?? 'global', text, pinned: opts.pinned })!;
  return r.item;
};

describe('applyOps', () => {
  it('adds items, repairing what a model gets wrong: an unknown kind becomes a fact, a bad scope becomes global', () => {
    const run = store.newRun('reflector');
    const counts = applyOps(store, run, [
      { op: 'add', kind: 'lesson', scope: 'project:/work/api', text: 'Run migrations before the integration tests' },
      { op: 'add', kind: 'nonsense' as never, scope: 'galaxy', text: 'Deploys go through the release script' },
      { op: 'add', kind: 'fact', scope: 'project:', text: 'An empty project scope is not a project' },
    ]);
    expect(counts).toMatchObject({ applied: 3, added: 3, skipped: 0 });
    const byText = (t: string) => store.listItems().find((i) => i.text.startsWith(t))!;
    expect(byText('Run migrations')).toMatchObject({ kind: 'lesson', scope: 'project:/work/api' });
    expect(byText('Deploys go')).toMatchObject({ kind: 'fact', scope: 'global' });
    expect(byText('An empty')).toMatchObject({ scope: 'global' });
  });

  it('counts an add that repeats what is known as a reinforcement, not a second item', () => {
    seed('Prefers pnpm over npm for JavaScript projects');
    const counts = applyOps(store, store.newRun('reflector'), [{ op: 'add', kind: 'preference', scope: 'global', text: 'Prefers pnpm over npm for JS projects' }]);
    expect(counts).toMatchObject({ applied: 1, reinforced: 1, added: 0 });
    expect(store.listItems()).toHaveLength(1);
  });

  it('an add with a key updates the item that key owns instead of adding another', () => {
    const run = store.newRun('heuristic');
    applyOps(store, run, [{ op: 'add', kind: 'workflow', scope: 'global', key: 'pm:/work/api', text: 'Uses pnpm in /work/api' }]);
    const again = applyOps(store, store.newRun('heuristic'), [{ op: 'add', kind: 'workflow', scope: 'global', key: 'pm:/work/api', text: 'Uses pnpm in /work/api, with workspaces' }]);
    expect(again).toMatchObject({ added: 0, updated: 1 }); // it changed its own item: an update, not an addition
    expect(store.listItems()).toHaveLength(1);
    expect(store.listItems()[0]!.text).toContain('with workspaces');
    const same = applyOps(store, store.newRun('heuristic'), [{ op: 'add', kind: 'workflow', scope: 'global', key: 'pm:/work/api', text: 'Uses pnpm in /work/api, with workspaces' }]);
    expect(same).toMatchObject({ added: 0, updated: 0, reinforced: 0, skipped: 1 }); // seen again, nothing changed: nothing to report
  });

  it('reinforces, updates and forgets items by id, and skips ids that do not exist', () => {
    const a = seed('Always run the linter before committing');
    const b = seed('Keep functions short and named for what they do');
    const counts = applyOps(store, store.newRun('reflector'), [
      { op: 'reinforce', id: a.id },
      { op: 'update', id: b.id, text: 'Keep functions short; name them for what they do' },
      { op: 'forget', id: a.id },
      { op: 'reinforce', id: 'm_missing' },
      { op: 'update', id: 'm_missing', text: 'x' },
      { op: 'forget', id: 'm_missing' },
    ]);
    expect(counts).toMatchObject({ applied: 3, skipped: 3, reinforced: 1, updated: 1, archived: 1 });
    expect(store.getItem(a.id)!.status).toBe('archived');
    expect(store.getItem(b.id)!.text).toBe('Keep functions short; name them for what they do');
  });

  it('automated sources cannot change or forget what a person pinned; the person can', () => {
    const pinned = seed('Never commit directly to main', { pinned: true });
    const partner = seed('Review every change before merging it');
    const auto = store.newRun('reflector');
    const counts = applyOps(store, auto, [
      { op: 'update', id: pinned.id, text: 'Commit to main whenever' },
      { op: 'forget', id: pinned.id },
      { op: 'merge', ids: [pinned.id, partner.id], text: 'merged away' },
      { op: 'reinforce', id: pinned.id }, // reinforcing is always fine
    ]);
    expect(counts).toMatchObject({ applied: 1, skipped: 3, reinforced: 1 });
    expect(store.getItem(pinned.id)).toMatchObject({ text: 'Never commit directly to main', status: 'active' });
    const mine = applyOps(store, store.newRun('user'), [{ op: 'update', id: pinned.id, text: 'Never commit directly to main or release' }]);
    expect(mine.updated).toBe(1);
    expect(store.getItem(pinned.id)!.text).toContain('or release');
  });

  it('a pinned item is never marked contradicted, whoever asks', () => {
    const pinned = seed('Never commit directly to main', { pinned: true });
    const loose = seed('Tabs for indentation in every project');
    const counts = applyOps(store, store.newRun('user'), [{ op: 'contradict', id: pinned.id }, { op: 'contradict', id: loose.id }]);
    expect(counts).toMatchObject({ applied: 1, skipped: 1 });
    expect(store.getItem(pinned.id)!.contradictions).toBe(0);
    expect(store.getItem(loose.id)!.contradictions).toBe(1);
  });

  it('merges only when every part exists', () => {
    const a = seed('Use vitest for unit tests in this repository');
    const b = seed('Unit tests live next to the code they test, named *.test.ts');
    const missing = applyOps(store, store.newRun('reflector'), [{ op: 'merge', ids: [a.id, 'm_missing'], text: 'x' }]);
    expect(missing).toMatchObject({ applied: 0, skipped: 1 });
    expect(store.listItems()).toHaveLength(2);
    const ok = applyOps(store, store.newRun('reflector'), [{ op: 'merge', ids: [a.id, b.id], text: 'Use vitest; tests live next to the code as *.test.ts', kind: 'convention' }]);
    expect(ok).toMatchObject({ applied: 1, updated: 1 });
    expect(store.listItems().filter((i) => i.status === 'active')).toHaveLength(1);
  });

  it('merges only notes of one scope, and not a note with itself', () => {
    const a = seed('Handlers live in src/routes, one file per resource', { scope: 'project:/work/api' });
    const b = seed('Every route has a matching test file in the same folder', { scope: 'project:/work/api' });
    const g = seed('Keep functions short and named for what they do');
    const across = applyOps(store, store.newRun('reflector'), [{ op: 'merge', ids: [a.id, g.id], text: 'merged across scopes' }]);
    expect(across).toMatchObject({ applied: 0, skipped: 1 });
    const itself = applyOps(store, store.newRun('reflector'), [{ op: 'merge', ids: [a.id, a.id], text: 'a with itself' }]);
    expect(itself).toMatchObject({ applied: 0, skipped: 1 });
    expect(store.listItems()).toHaveLength(3);
    const ok = applyOps(store, store.newRun('reflector'), [{ op: 'merge', ids: [a.id, b.id], text: 'Handlers live in src/routes, each with a test beside it' }]);
    expect(ok).toMatchObject({ applied: 1, updated: 1 });
    expect(store.listItems().find((i) => i.text.startsWith('Handlers live'))!.scope).toBe('project:/work/api');
  });

  it('adds a skill, and counts it', () => {
    const counts = applyOps(store, store.newRun('heuristic'), [
      { op: 'skill', name: 'Ship a release', description: 'How a release goes out', whenToUse: 'When asked to cut a release', steps: ['npm version patch', 'git push --follow-tags'], scope: 'global' },
    ]);
    expect(counts).toMatchObject({ applied: 1, skills: 1 });
    expect(store.listSkills()).toHaveLength(1);
  });

  it('changes at most 24 things in one go (or the limit it is given); the rest are skipped, not applied', () => {
    const ops: ProposedOp[] = Array.from({ length: 30 }, (_, i) => ({ op: 'add', kind: 'fact', scope: 'global', text: `Distinct durable fact number ${i} about project ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i}` }));
    const counts = applyOps(store, store.newRun('reflector'), ops);
    expect(counts.applied).toBe(24);
    expect(counts.skipped).toBe(6);
    const few = applyOps(store, store.newRun('reflector'), ops, { maxOps: 2 });
    expect(few.applied + few.skipped).toBe(30);
    expect(few.skipped).toBeGreaterThanOrEqual(28);
  });

  it('ignores an op it does not know, and persists what it applied', () => {
    const counts = applyOps(store, store.newRun('reflector'), [{ op: 'teleport' } as never, { op: 'add', kind: 'fact', scope: 'global', text: 'The build output goes to dist' }]);
    expect(counts).toMatchObject({ applied: 1, skipped: 1 });
    expect(new MemoryStore(env.paths).listItems()).toHaveLength(1); // flushed to disk
  });

  it('an op can name its own source and reason for the journal', () => {
    const run = store.newRun('reflector', 'weekly review');
    applyOps(store, run, [{ op: 'add', kind: 'fact', scope: 'global', text: 'The staging database is reset every night', source: 'heuristic', why: 'seen in three sessions' }]);
    const entry = store.readJournal().find((e) => e.op === 'add')!;
    expect(entry).toMatchObject({ source: 'heuristic', reason: 'seen in three sessions' });
    const second = store.newRun('reflector', 'weekly review');
    applyOps(store, second, [{ op: 'add', kind: 'fact', scope: 'global', text: 'Backups of staging are kept for a week' }]);
    expect(store.readJournal().find((e) => e.runId === second.runId)).toMatchObject({ source: 'reflector', reason: 'weekly review' });
  });
});
