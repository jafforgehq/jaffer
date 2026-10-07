import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngine, makeEnv, type TestEnv } from './helpers/env';
import { makeMemoryApi } from '../src/core/memory-api';

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

const line = (o: object) => JSON.stringify(o);
const ts = (n: number) => new Date(Date.UTC(2026, 8, 20, 10, n)).toISOString();

/**
 * What an install from before 0.3.0 left on disk: episodes of the in-app agent (`t: 'agent'`), commands tagged `by: 'agent'`,
 * and a journal that mentions operations this version no longer produces. Updating must read all of it without complaint.
 */
function writeLegacyHome(): void {
  const dir = env.paths.memoryEpisodesDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-09-20.jsonl'),
    [
      line({ t: 'cmd', seq: 1, id: 'e1', ts: ts(1), cmd: 'pnpm test', exit: 0, cwd: '/work/app', project: '/work/app', durMs: 900, by: 'user' }),
      line({ t: 'agent', seq: 2, id: 'e2', ts: ts(2), cwd: '/work/app', project: '/work/app', user: 'No, use pnpm here', reply: 'ok', tools: ['run_command'], correction: true }),
      line({ t: 'cmd', seq: 3, id: 'e3', ts: ts(3), cmd: 'pnpm build', exit: 1, cwd: '/work/app', project: '/work/app', durMs: 4000, out: 'error TS2304', by: 'agent' }),
      line({ t: 'ext', seq: 4, id: 'e4', ts: ts(4), cwd: '/work/app', project: '/work/app', agent: 'claude-code', role: 'user', text: 'always run pnpm lint before committing', correction: false }),
      line({ t: 'note', seq: 5, id: 'e5', ts: ts(5), text: 'remember the staging url' }),
      '{"torn": ', // a half-written line from a crash
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    env.paths.memoryJournal,
    [
      line({ seq: 1, runId: 'run_old', ts: ts(6), source: 'user', op: 'delete', target: 'item', id: 'gone', before: { id: 'gone' }, after: null, reason: 'delete' }),
      line({ seq: 2, runId: 'run_old', ts: ts(7), source: 'user', op: 'restore', target: 'item', id: 'back', before: null, after: { id: 'back' }, reason: 'restore' }),
    ].join('\n') + '\n',
  );
}

describe('memory written by an older version', () => {
  it('is read without complaint: unknown episode kinds are skipped, the rest still teaches', async () => {
    env.config.patch({ onboarded: true });
    writeLegacyHome();
    const first = makeEngine(env);
    first.remember('Prefer pnpm over npm in every JavaScript project', { kind: 'preference', pinned: true });
    first.store.flush();
    const engine = makeEngine(env); // a new process reading the old files
    expect(engine.stats().episodesPending).toBeGreaterThanOrEqual(4);
    const res = await engine.reflect({ force: true });
    expect(res.error).toBeUndefined();
    expect(engine.store.listItems().some((i) => i.text.includes('Prefer pnpm'))).toBe(true); // nothing was lost
    expect(engine.store.listItems().some((i) => /pnpm lint/.test(i.text))).toBe(true); // an instruction given to Claude Code is still learned
    expect(engine.stats().episodesPending).toBe(0);
    expect(engine.context({ cwd: '/work/app', budgetChars: 4000 }).text).toContain('pnpm');
  });

  it('shows the old journal in the Activity log and can still undo a run recorded by the old version', async () => {
    env.config.patch({ onboarded: true });
    writeLegacyHome();
    const engine = makeEngine(env);
    const api = makeMemoryApi(engine);
    const log = await api['memory.log']!({ limit: 50 });
    expect(JSON.stringify(log)).toContain('run_old');
    await expect(api['memory.revert']!({ runId: 'run_old' })).resolves.toBeDefined();
  });
});
