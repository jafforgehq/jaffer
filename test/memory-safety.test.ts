import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOps } from '../src/core/memory/apply';
import { consolidateHeuristic } from '../src/core/memory/consolidate';
import { EpisodeLog } from '../src/core/memory/episodes';
import { extractJson } from '../src/core/memory/llm';
import { MemoryStore } from '../src/core/memory/store';
import { makeEngine, makeEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('forgetting', () => {
  const seedEngine = () => {
    const engine = makeEngine(env);
    const pinned = (engine.remember('Never commit directly to the main branch', { pinned: true }) as { item: { id: string } }).item;
    const loose = (engine.remember('Prefers tabs over spaces for indentation', {}) as { item: { id: string } }).item;
    const other = (engine.remember('Deploys go out through the release script', {}) as { item: { id: string } }).item;
    return { engine, pinned, loose, other };
  };
  const active = (engine: ReturnType<typeof makeEngine>) => engine.store.listItems().map((i) => i.id);

  it('a description only forgets a memory that really looks like it, never the nearest of unrelated ones', () => {
    const { engine, loose, other } = seedEngine();
    expect(engine.forget('deploy to production on friday after lunch').archived).toEqual([]); // shares one word with the deploy note
    expect(active(engine)).toContain(other.id);
    expect(engine.forget('tabs over spaces').archived.map((i) => i.id)).toEqual([loose.id]);
  });

  it('a pinned memory is not forgotten by a description, and an agent cannot forget it even by its id', () => {
    const { engine, pinned } = seedEngine();
    expect(engine.forget('never commit directly to main').archived).toEqual([]);
    const byAgent = engine.forget(pinned.id, { agent: true });
    expect(byAgent.archived).toEqual([]);
    expect(byAgent.refused).toBe('pinned');
    expect(active(engine)).toContain(pinned.id);
  });

  it('the person can forget anything by its id, pinned or not, and the change is logged as theirs; an agent’s is logged as an agent’s', () => {
    const { engine, pinned, loose } = seedEngine();
    expect(engine.forget(pinned.id).archived.map((i) => i.id)).toEqual([pinned.id]);
    expect(engine.forget(loose.id, { agent: true }).archived.map((i) => i.id)).toEqual([loose.id]);
    const entries = engine.store.readJournal().filter((e) => e.op === 'archive');
    expect(entries.find((e) => e.id === pinned.id)!.source).toBe('user');
    expect(entries.find((e) => e.id === loose.id)!.source).toBe('agent');
  });
});

describe('remember', () => {
  it('stores the text as given, and does not teach itself the same text again from a note (no rewritten wording, no doubled evidence, no global copy of a project memory)', async () => {
    const engine = makeEngine(env);
    const res = engine.remember('Prefer pnpm. Lockfiles must be committed.', { source: 'agent', scope: 'project:/work/api', kind: 'convention' }) as { item: { id: string } };
    await engine.reflect({ force: true });
    const items = engine.store.listItems().filter((i) => !i.key); // the machine facts the rules keep are not what is being tested
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: res.item.id, text: 'Prefer pnpm. Lockfiles must be committed.', evidence: 1, scope: 'project:/work/api', source: 'agent' });
  });
});

describe('what may be stored', () => {
  it('rejects text that already has a secret masked out of it, like text that holds a secret', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('heuristic');
    expect(store.add(run, { kind: 'workflow', scope: 'global', text: 'Deploy with TOKEN=[REDACTED] ./release.sh' })).toBeNull();
    expect(store.add(run, { kind: 'fact', scope: 'global', text: 'The staging url is internal, ask the platform team' })).not.toBeNull();
    expect(store.addSkill(run, { name: 'Call the api', description: 'x', whenToUse: 'x', steps: ['curl -H "Authorization: Bearer [REDACTED]" https://api.example.com'], scope: 'global' })).toBeNull();
    expect(store.addSkill(run, { name: 'Call the api', description: 'x', whenToUse: 'x', steps: ['curl https://api.example.com/health'], scope: 'global' })).not.toBeNull();
  });
});

describe('undo', () => {
  it('undoing an older run does not wipe out what happened to its items since', () => {
    const store = new MemoryStore(env.paths);
    const reflect = store.newRun('reflector');
    const a = store.add(reflect, { kind: 'convention', scope: 'global', text: 'Handlers live in src/routes, one file per resource' })!.item;
    const b = store.add(reflect, { kind: 'convention', scope: 'global', text: 'Tests live next to the code they test' })!.item;
    store.pin(store.newRun('user'), a.id, true); // the person pinned the first one afterwards
    store.update(store.newRun('user'), b.id, { text: 'Tests live next to the code, named *.test.ts' }); // and reworded the second
    expect(store.revertRun(reflect.runId)).toBe(0); // both changed since: nothing to undo safely
    expect(store.getItem(a.id)).toMatchObject({ pinned: true, status: 'active' });
    expect(store.getItem(b.id)!.text).toBe('Tests live next to the code, named *.test.ts');
  });

  it('still undoes everything a run did when nothing has touched it since, also when the run changed one item twice', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('reflector');
    const a = store.add(run, { kind: 'fact', scope: 'global', text: 'The build output goes to dist' })!.item;
    store.update(run, a.id, { text: 'The build output goes to dist, never committed' });
    store.add(run, { kind: 'fact', scope: 'global', text: 'Staging resets every night at two' });
    expect(store.revertRun(run.runId)).toBe(3);
    expect(store.listItems()).toHaveLength(0);
  });

  it('undoing the reinforcement of an item (evidence and time seen are not what a person edits) still goes through', () => {
    const store = new MemoryStore(env.paths);
    const a = store.add(store.newRun('user'), { kind: 'fact', scope: 'global', text: 'Prefers pnpm over npm for JavaScript projects' })!.item;
    const run = store.newRun('reflector');
    store.reinforce(run, a.id);
    store.markUsed([a.id]); // shown to an agent since: only counters move
    expect(store.revertRun(run.runId)).toBe(1);
    expect(store.getItem(a.id)!.evidence).toBe(1);
  });
});

describe('items a rule owns', () => {
  const rule = (store: MemoryStore, text: string) => applyOps(store, store.newRun('heuristic'), [{ op: 'add', kind: 'environment', scope: 'global', key: 'h:env', text }]);

  it('seen again unchanged, they stay fresh without a journal entry, extra evidence or a count: the undo log is for changes', () => {
    const store = new MemoryStore(env.paths);
    rule(store, 'Runs macOS on arm64 with zsh');
    const before = store.getItem(store.findByKey('h:env')!.id)!;
    const journal = store.readJournal(0).length;
    for (let i = 0; i < 5; i++) expect(rule(store, 'Runs macOS on arm64 with zsh')).toMatchObject({ applied: 0, skipped: 1, added: 0, updated: 0, reinforced: 0 });
    const after = store.findByKey('h:env')!;
    expect(store.readJournal(0)).toHaveLength(journal);
    expect(after.evidence).toBe(before.evidence);
    expect(after.confidence).toBe(before.confidence);
  });

  it('a rule never rewrites what the person pinned, or reworded', () => {
    const store = new MemoryStore(env.paths);
    rule(store, 'Runs macOS on arm64 with zsh');
    const id = store.findByKey('h:env')!.id;
    store.pin(store.newRun('user'), id, true);
    expect(rule(store, 'Runs macOS on x64 with bash')).toMatchObject({ updated: 0 });
    expect(store.getItem(id)!.text).toBe('Runs macOS on arm64 with zsh');
    store.pin(store.newRun('user'), id, false);
    store.update(store.newRun('user'), id, { text: 'Works on a MacBook Pro with zsh and Homebrew' }); // the person took it over
    rule(store, 'Runs macOS on arm64 with zsh');
    expect(store.getItem(id)!.text).toBe('Works on a MacBook Pro with zsh and Homebrew');
  });

  it('a rule still refines its own item when the facts change', () => {
    const store = new MemoryStore(env.paths);
    rule(store, 'Runs macOS on arm64 with zsh');
    expect(rule(store, 'Runs macOS on arm64 with fish')).toMatchObject({ updated: 1, added: 0 });
    expect(store.listItems()).toHaveLength(1);
    expect(store.listItems()[0]!.text).toContain('fish');
  });
});

describe('consolidation', () => {
  it('keeps two pinned notes apart, however alike they read', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('user');
    const a = store.add(run, { kind: 'workflow', scope: 'global', text: 'Run the full test suite before pushing to the shared branch', pinned: true })!.item;
    const b = store.add(run, { kind: 'workflow', scope: 'global', text: 'Always tag releases with the version number', pinned: true })!.item;
    store.update(run, b.id, { text: 'Run the full test suite before pushing any change to the main branch' }); // an update never dedupes: the pair meets at consolidation
    expect(a.id).not.toBe(b.id);
    const counts = consolidateHeuristic(store, store.newRun('consolidator'));
    expect(counts.merged).toBe(0);
    expect(store.getItem(a.id)!.status).toBe('active');
    expect(store.getItem(b.id)!.status).toBe('active');
  });

  it('still folds a loose duplicate into the note that is pinned', () => {
    const store = new MemoryStore(env.paths);
    const pinned = store.add(store.newRun('user'), { kind: 'workflow', scope: 'global', text: 'Run the full test suite before pushing to the shared branch', pinned: true })!.item;
    const loose = store.add(store.newRun('reflector'), { kind: 'workflow', scope: 'global', text: 'Always tag releases with the version number' })!.item;
    store.update(store.newRun('reflector'), loose.id, { text: 'Run the full test suite before pushing any change to the main branch' });
    expect(loose.id).not.toBe(pinned.id);
    expect(consolidateHeuristic(store, store.newRun('consolidator')).merged).toBe(1);
    const left = store.listItems();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ pinned: true, text: 'Run the full test suite before pushing to the shared branch' }); // the pinned wording wins, and it stays pinned
    expect(store.getItem(pinned.id)!.status).toBe('superseded');
  });
});

describe('extractJson', () => {
  it('finds the JSON after a bracketed phrase of prose, and in a fence, and skips what is not JSON', () => {
    expect(extractJson('result [see digest]: {"ops":[{"op":"add"}]}')).toEqual({ ops: [{ op: 'add' }] });
    expect(extractJson('Sure! Here you go:\n```json\n{"ops":[]}\n```\nAnything else?')).toEqual({ ops: [] });
    expect(extractJson('note {not json} then {"ops":[1]}')).toEqual({ ops: [1] });
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(extractJson('no json here at all')).toBeNull();
    expect(extractJson('{"broken": ')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('is not fooled by a bracket inside a string, and gives up on a flood of openers instead of hanging', () => {
    expect(extractJson('{"text":"a ] and a } inside","n":1}')).toEqual({ text: 'a ] and a } inside', n: 1 });
    const t0 = Date.now();
    expect(extractJson('{['.repeat(20_000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('episode numbers', () => {
  it('never restart below what the reflector has already read, even when every day file was pruned', () => {
    const log = new EpisodeLog(env.paths, Date.now, 50);
    const ep = log.append({ t: 'note', text: 'a first episode after the prune' })!;
    expect(ep.seq).toBe(51);
    expect(new EpisodeLog(env.paths, Date.now, 10).append({ t: 'note', text: 'and the next' })!.seq).toBe(52); // the files say 51
    expect(fs.readdirSync(env.paths.memoryEpisodesDir)).toHaveLength(1);
  });

  it('the engine keeps its episodes above its own cursor', async () => {
    const engine = makeEngine(env);
    engine.updateCursor((c) => {
      c.reflectedSeq = 80;
    });
    const again = makeEngine(env); // a daemon restart: no episode files, a cursor at 80
    expect(again.observe({ t: 'note', text: 'something that must be reflected on' })!.seq).toBe(81);
  });
});
