import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlm, makeEngine, makeEnv, type TestEnv } from './helpers/env';
import { MemoryStore } from '../src/core/memory/store';
import { parseOps } from '../src/core/memory/reflector';
import { extractJson } from '../src/core/memory/llm';
import { consolidateHeuristic } from '../src/core/memory/consolidate';
import { buildContext } from '../src/core/memory/context';
import { applyBlock, BEGIN, END, syncClaudeSkills, syncExports } from '../src/core/memory/exports';
import { effectiveConfidence } from '../src/core/memory/ranking';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('MemoryStore', () => {
  it('adds, dedupes near-duplicates by reinforcing, and persists', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('user');
    const a = store.add(run, { kind: 'preference', scope: 'global', text: 'Prefers pnpm over npm for JavaScript projects' })!;
    expect(a.deduped).toBe(false);
    const b = store.add(run, { kind: 'preference', scope: 'global', text: 'Prefers pnpm over npm for JS projects' })!;
    expect(b.deduped).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.evidence).toBe(2);
    expect(b.item.confidence).toBeGreaterThan(a.item.confidence);
    store.flush();
    const again = new MemoryStore(env.paths);
    expect(again.listItems()).toHaveLength(1);
  });

  it('refuses to store secrets', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('agent');
    expect(store.add(run, { kind: 'fact', scope: 'global', text: 'The API key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx' })).toBeNull();
    expect(store.add(run, { kind: 'fact', scope: 'global', text: 'export GITHUB_TOKEN=abcdef123456 for CI' })).toBeNull();
    expect(store.listItems()).toHaveLength(0);
  });

  it('supports contradiction, archive, restore and merge', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('reflector');
    const a = store.add(run, { kind: 'convention', scope: 'global', text: 'Use tabs for indentation in all files', confidence: 0.8 })!.item;
    const c1 = store.contradict(run, a.id)!;
    expect(c1.confidence).toBeLessThan(0.8);
    expect(c1.contradictions).toBe(1);
    store.contradict(run, a.id);
    store.contradict(run, a.id);
    expect(store.getItem(a.id)!.status).toBe('archived');
    store.restore(run, a.id);
    expect(store.getItem(a.id)!.status).toBe('active');
    const b = store.add(run, { kind: 'convention', scope: 'global', text: 'Code style requires two-space indentation' })!.item;
    const merged = store.merge(run, [a.id, b.id], 'Indent with two spaces, never tabs')!;
    expect(store.getItem(a.id)!.status).toBe('superseded');
    expect(store.getItem(a.id)!.supersededBy).toBe(merged.id);
    expect(store.listItems()).toHaveLength(1);
  });

  it('reverts a whole reflection run from the journal', () => {
    const store = new MemoryStore(env.paths);
    const keep = store.add(store.newRun('user'), { kind: 'preference', scope: 'global', text: 'Likes concise answers from agents' })!.item;
    const run = store.newRun('reflector', 'test');
    store.add(run, { kind: 'fact', scope: 'global', text: 'A hallucinated fact that should be undone' });
    store.update(run, keep.id, { text: 'Hates concise answers (wrongly changed)' });
    expect(store.listItems()).toHaveLength(2);
    const n = store.revertRun(run.runId);
    expect(n).toBe(2);
    expect(store.listItems()).toHaveLength(1);
    expect(store.getItem(keep.id)!.text).toBe('Likes concise answers from agents');
    expect(store.revertRun(run.runId)).toBe(0); // cannot revert twice
  });

  it('upsertByKey updates text in place and never resurrects archived rule items', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('heuristic');
    const a = store.upsertByKey(run, 'h:test', { kind: 'workflow', scope: 'global', text: 'Run pnpm test before committing' })!;
    const b = store.upsertByKey(run, 'h:test', { kind: 'workflow', scope: 'global', text: 'Run pnpm test and pnpm lint before committing' })!;
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.text).toContain('lint');
    store.archive(run, a.item.id);
    expect(store.upsertByKey(run, 'h:test', { kind: 'workflow', scope: 'global', text: 'Run pnpm test before committing again' })).toBeNull();
  });
});

describe('decay', () => {
  it('fades unreinforced memories and lets pinned ones stay', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    let now = t0;
    const store = new MemoryStore(env.paths, () => now);
    const run = store.newRun('heuristic');
    const proj = store.add(run, { kind: 'project', scope: 'global', text: 'Active project is the billing service rewrite', confidence: 0.5 })!.item;
    const pinned = store.add(run, { kind: 'project', scope: 'global', text: 'Always keep the changelog updated in docs', confidence: 0.5, pinned: true })!.item;
    now = t0 + 200 * 86_400_000;
    expect(effectiveConfidence(store.getItem(proj.id)!, now)).toBeLessThan(0.06);
    expect(effectiveConfidence(store.getItem(pinned.id)!, now)).toBeGreaterThanOrEqual(0.9);
    const res = consolidateHeuristic(store, store.newRun('consolidator'));
    expect(res.archived).toBe(1);
    expect(store.getItem(proj.id)!.status).toBe('archived');
    expect(store.getItem(pinned.id)!.status).toBe('active');
  });
});

describe('consolidation', () => {
  it('merges near-duplicates the dedupe threshold let through', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('reflector');
    store.add(run, { kind: 'preference', scope: 'global', text: 'Wants git commit messages in conventional commit format' });
    // Added as something distinct, then reworded (update never dedupes) so the pair only meets at consolidation time.
    const b = store.add(run, { kind: 'preference', scope: 'global', text: 'Review requests need a linked ticket id' })!.item;
    store.update(run, b.id, { text: 'Git commit messages follow conventional commit format with scope' });
    expect(store.listItems().length).toBe(2);
    const res = consolidateHeuristic(store, store.newRun('consolidator'));
    expect(res.merged).toBe(1);
    expect(store.listItems()).toHaveLength(1);
  });
});

describe('context', () => {
  it('prefers project knowledge when working inside that project and respects the budget', () => {
    const store = new MemoryStore(env.paths);
    const run = store.newRun('user');
    store.add(run, { kind: 'preference', scope: 'global', text: 'Answers should be terse; no emojis', confidence: 0.9 });
    store.add(run, { kind: 'convention', scope: 'project:/work/app', text: 'Tests use vitest; run with pnpm test', confidence: 0.9 });
    store.add(run, { kind: 'convention', scope: 'project:/work/other', text: 'Other repo uses Jest and yarn', confidence: 0.9 });
    const inApp = buildContext(store, { cwd: '/work/app/src', notes: false });
    expect(inApp.text).toContain('vitest');
    expect(inApp.text).toContain('terse');
    expect(inApp.text).not.toContain('Jest');
    const tiny = buildContext(store, { cwd: '/work/app', notes: false, budgetChars: 120 });
    expect(tiny.text.length).toBeLessThan(400);
  });

  it('includes the user NOTES.md', () => {
    const store = new MemoryStore(env.paths);
    fs.writeFileSync(env.paths.memoryNotes, 'My staging server is called atlas.');
    expect(buildContext(store, {}).text).toContain('atlas');
  });
});

describe('parseOps / extractJson', () => {
  it('extracts JSON from fenced and chatty model output', () => {
    expect(extractJson('Sure!\n```json\n{"ops":[{"op":"reinforce","id":"m_1"}]}\n```')).toEqual({ ops: [{ op: 'reinforce', id: 'm_1' }] });
    expect(extractJson('blah {"a":"}"} trailing')).toEqual({ a: '}' });
    expect(extractJson('no json here')).toBeNull();
  });

  it('drops ops that reference unknown ids or invalid kinds', () => {
    const raw = JSON.stringify({
      ops: [
        { op: 'reinforce', id: 'm_ok' },
        { op: 'forget', id: 'm_ghost' },
        { op: 'add', kind: 'nonsense', text: 'x' },
        { op: 'add', kind: 'lesson', scope: 'global', text: 'Never force-push to main' },
        { op: 'merge', ids: ['m_ok', 'm_ghost'], text: 'merged' },
      ],
    });
    const { ops, dropped } = parseOps(raw, new Set(['m_ok']));
    expect(ops.map((o) => o.op)).toEqual(['reinforce', 'add']);
    expect(dropped).toBe(3);
  });
});

describe('MemoryEngine', () => {
  it('learns offline from episodes with no model configured', async () => {
    env.config.patch({ onboarded: true });
    const engine = makeEngine(env);
    for (const c of ['pnpm install', 'pnpm test', 'pnpm test', 'pnpm test', 'pnpm build']) engine.observeCommand({ cmd: c, exit: 0, cwd: '/work/app', project: '/work/app' });
    const res = await engine.reflect();
    expect(res.mode).toBe('heuristic');
    expect(res.added).toBeGreaterThan(0);
    const texts = engine.store.listItems().map((i) => i.text).join('\n');
    expect(texts).toContain('pnpm');
    expect(fs.readFileSync(env.paths.memoryIndex, 'utf8')).toContain('pnpm');
    // second reflection with nothing new must not duplicate anything
    const before = engine.store.listItems().length;
    await engine.reflect();
    expect(engine.store.listItems().length).toBe(before);
  });

  it('applies model-curated ops and journals them so they can be reverted', async () => {
    env.config.patch({ onboarded: true });
    const llm = new FakeLlm(() => JSON.stringify({ ops: [{ op: 'add', kind: 'lesson', scope: 'project:/work/app', text: 'Run migrations before starting the dev server or it crashes on boot', confidence: 0.8, why: 'user corrected' }] }));
    const engine = makeEngine(env, llm);
    engine.observeAgentTurn({ user: 'No, run the migrations first', reply: 'Ok', tools: ['run_command'], cwd: '/work/app', project: '/work/app', previousAssistant: true });
    const res = await engine.reflect({ force: true });
    expect(res.mode).toBe('both');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.user).toContain('USER CORRECTED THE AGENT');
    expect(engine.store.listItems().some((i) => i.text.includes('migrations'))).toBe(true);
    const n = engine.store.revertRun(res.runId);
    expect(n).toBeGreaterThan(0);
    expect(engine.store.listItems().some((i) => i.text.includes('Run migrations before'))).toBe(false);
  });

  it('learns an explicit instruction on the next tick, without waiting for more activity', async () => {
    // an instruction given to an agent (here: in a Claude Code transcript) used to sit pending until three or four more
    // events arrived, so a lone "from now on always use tabs" could go unlearned for a long time
    env.config.patch({ onboarded: true, memory: { llm: 'off' } });
    const engine = makeEngine(env);
    engine.observe({ t: 'ext', agent: 'claude-code', role: 'user', text: 'From now on always use tabs, never spaces, for indentation.', cwd: '/work/app', correction: false });
    expect(engine.store.listItems()).toHaveLength(0);
    await engine.tick();
    expect(engine.store.listItems().some((i) => /tabs/i.test(i.text))).toBe(true);
    // while ordinary chatter alone still does not trigger a pass
    const quiet = makeEngine(makeEnv());
    quiet.observe({ t: 'ext', agent: 'claude-code', role: 'user', text: 'Can you look at the failing test?', cwd: '/work/app', correction: false });
    await quiet.tick();
    expect(quiet.store.listItems()).toHaveLength(0);
  });

  it('never sends secrets to the model', async () => {
    env.config.patch({ onboarded: true });
    const llm = new FakeLlm(() => '{"ops":[]}');
    const engine = makeEngine(env, llm);
    engine.observeCommand({ cmd: 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://api.x', exit: 1, cwd: '/w', out: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 denied' });
    engine.observeCommand({ cmd: 'echo $OPENAI_API_KEY', exit: 0, cwd: '/w' });
    await engine.reflect({ force: true });
    const sent = llm.calls[0]!.user;
    expect(sent).not.toContain('abcdefghijklmnop1234567890');
    expect(sent).not.toContain('ghp_');
    expect(sent).not.toContain('OPENAI_API_KEY');
  });

  it('skips the model when memory.llm is off or the user has not consented', async () => {
    const llm = new FakeLlm(() => '{"ops":[]}');
    const engine = makeEngine(env, llm);
    engine.observeCommand({ cmd: 'make test', exit: 0, cwd: '/w', project: '/w' });
    await engine.reflect({ force: true });
    expect(llm.calls).toHaveLength(0); // not onboarded
    env.config.patch({ onboarded: true, memory: { llm: 'off' } });
    engine.observeCommand({ cmd: 'make test', exit: 0, cwd: '/w', project: '/w' });
    await engine.reflect({ force: true });
    expect(llm.calls).toHaveLength(0);
  });

  it('survives a failing model: heuristics still apply and the error is reported', async () => {
    env.config.patch({ onboarded: true });
    const llm = { complete: async () => Promise.reject(new Error('529 overloaded')) };
    const engine = makeEngine(env, llm);
    for (let i = 0; i < 5; i++) engine.observeCommand({ cmd: 'yarn test', exit: 0, cwd: '/w', project: '/w' });
    const res = await engine.reflect({ force: true });
    expect(res.error).toContain('overloaded');
    expect(res.added).toBeGreaterThan(0);
  });

  it('recall finds relevant memories and counts the use', () => {
    const engine = makeEngine(env);
    engine.remember('Deploys go through the `release.sh` script, never by hand', { kind: 'workflow' });
    engine.remember('Prefers dark themes everywhere');
    const r = engine.recall('how do I deploy a release');
    expect(r.items[0]!.text).toContain('release.sh');
    expect(engine.store.getItem(r.items[0]!.id)!.uses).toBe(1);
  });

  it('remember rejects secrets and forget archives by query', () => {
    const engine = makeEngine(env);
    expect('error' in engine.remember('password=hunter2hunter2 for the db')).toBe(true);
    const r = engine.remember('The staging cluster is called atlas');
    expect('item' in r).toBe(true);
    const f = engine.forget('staging cluster atlas');
    expect(f.archived).toHaveLength(1);
    expect(engine.store.listItems()).toHaveLength(0);
  });

  it('prunes old episodes during consolidation', async () => {
    env.config.patch({ onboarded: true });
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    let now = t0;
    const engine = makeEngine(env, undefined, () => now);
    engine.observeCommand({ cmd: 'make build', exit: 0, cwd: '/w' });
    now = t0 + 60 * 86_400_000;
    engine.observeCommand({ cmd: 'make build', exit: 0, cwd: '/w' });
    expect(fs.readdirSync(env.paths.memoryEpisodesDir)).toHaveLength(2);
    await engine.consolidate();
    expect(fs.readdirSync(env.paths.memoryEpisodesDir)).toHaveLength(1);
  });
});

describe('exports', () => {
  it('manages a delimited block without touching the rest of the file', () => {
    const file = path.join(env.userHome, 'CLAUDE.md');
    fs.writeFileSync(file, '# My own rules\n\nBe kind.\n');
    expect(applyBlock(file, `${BEGIN}\nhello\n${END}`)).toBe('written');
    expect(applyBlock(file, `${BEGIN}\nhello\n${END}`)).toBe('unchanged');
    expect(applyBlock(file, `${BEGIN}\nupdated\n${END}`)).toBe('written');
    const txt = fs.readFileSync(file, 'utf8');
    expect(txt).toContain('Be kind.');
    expect(txt).toContain('updated');
    expect(txt).not.toContain('hello');
    expect(applyBlock(file, null)).toBe('removed');
    expect(fs.readFileSync(file, 'utf8')).toBe('# My own rules\n\nBe kind.\n');
  });

  it('only writes to agents that are installed and enabled', () => {
    const engine = makeEngine(env);
    engine.remember('Prefers pnpm over npm', { kind: 'preference' });
    fs.mkdirSync(path.join(env.userHome, '.claude'));
    const res = syncExports(engine.store, ['claude-code', 'codex'], env.userHome);
    expect(res.find((r) => r.target === 'claude-code')!.status).toBe('written');
    expect(res.find((r) => r.target === 'codex')!.status).toBe('skipped'); // ~/.codex absent
    expect(fs.existsSync(path.join(env.userHome, '.codex'))).toBe(false);
    expect(fs.readFileSync(path.join(env.userHome, '.claude', 'CLAUDE.md'), 'utf8')).toContain('pnpm');
    // opting out removes the block again
    syncExports(engine.store, [], env.userHome);
    expect(fs.readFileSync(path.join(env.userHome, '.claude', 'CLAUDE.md'), 'utf8')).not.toContain('pnpm');
  });

  it('turns learned skills into Claude Code skills and cleans up stale ones', () => {
    const engine = makeEngine(env);
    fs.mkdirSync(path.join(env.userHome, '.claude'));
    const run = engine.store.newRun('reflector');
    const s = engine.store.addSkill(run, { name: 'Ship a release', description: 'Tag and publish', whenToUse: 'When cutting a release', steps: ['git tag v1', 'git push --tags'], confidence: 0.8 })!;
    const out = syncClaudeSkills(engine.store, true, env.userHome);
    expect(out.written).toBe(1);
    const dir = fs.readdirSync(path.join(env.userHome, '.claude', 'skills')).find((d) => d.startsWith('jaffer-'))!;
    const md = fs.readFileSync(path.join(env.userHome, '.claude', 'skills', dir, 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^---\nname: jaffer-/);
    expect(md).toContain('git push --tags');
    engine.store.archiveSkill(run, s.id);
    expect(syncClaudeSkills(engine.store, true, env.userHome).removed).toBe(1);
  });
});
