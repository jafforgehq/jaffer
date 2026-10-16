import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trashAsk, trashConversations, type TrashDeps } from '../src/main/trash-conversations';
import { makeEnv, type TestEnv } from './helpers/env';

/** The Trash is a fake here: `trashItem` records the path and moves nothing (the real `shell.trashItem` is never called by a test). */
let env: TestEnv;
let claudeDir: string;
let dir: string;
beforeEach(() => {
  env = makeEnv();
  claudeDir = path.join(env.userHome, '.claude');
  dir = path.join(claudeDir, 'projects', '-Users-me-code');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => env.cleanup());

const uuid = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';
const plant = (n: number, withDir = false) => {
  fs.writeFileSync(path.join(dir, `${uuid(n)}.jsonl`), '{}\n');
  if (withDir) fs.mkdirSync(path.join(dir, uuid(n), 'subagents'), { recursive: true });
};

function deps(over: Partial<TrashDeps> = {}) {
  const trashed: string[] = [];
  const d = {
    claudeDir,
    trashItem: vi.fn(async (p: string) => void trashed.push(p)),
    confirm: vi.fn(async (_n: number) => true),
    liveIds: vi.fn(async () => [] as string[]),
    ...over,
  };
  return { d, trashed };
}

describe('trashConversations (1.3.0): past conversations to the Trash, after one question', () => {
  it('asks once with the count, then trashes each transcript and after it its folder, in the order asked', async () => {
    plant(1, true);
    plant(2);
    const { d, trashed } = deps();
    expect(await trashConversations([uuid(2), uuid(1)], d)).toEqual({ trashed: [uuid(2), uuid(1)], refused: [] });
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.confirm).toHaveBeenCalledWith(2);
    expect(trashed).toEqual([path.join(dir, `${uuid(2)}.jsonl`), path.join(dir, `${uuid(1)}.jsonl`), path.join(dir, uuid(1))]);
  });

  it('Cancel trashes nothing', async () => {
    plant(1);
    const { d, trashed } = deps({ confirm: vi.fn(async () => false) });
    expect(await trashConversations([uuid(1)], d)).toEqual({ trashed: [], refused: [], cancelled: true });
    expect(trashed).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${uuid(1)}.jsonl`))).toBe(true);
  });

  it('one that fails does not stop the others, and is reported as an error', async () => {
    plant(1);
    plant(2);
    plant(3);
    const { d, trashed } = deps();
    d.trashItem = vi.fn(async (p: string) => {
      if (p.includes(uuid(2))) throw new Error('busy');
      trashed.push(p);
    });
    expect(await trashConversations([uuid(1), uuid(2), uuid(3)], d)).toEqual({ trashed: [uuid(1), uuid(3)], refused: [{ id: uuid(2), reason: 'error' }] });
    expect(trashed).toHaveLength(2);
  });

  it('a conversation still running is refused and not counted in the question; one not found is reported; an invalid id is dropped', async () => {
    plant(1);
    plant(2);
    const { d, trashed } = deps({ liveIds: vi.fn(async () => [uuid(2)]) });
    const r = await trashConversations([uuid(1), uuid(2), uuid(3), '../etc', 42 as never, uuid(1)], d);
    expect(r).toEqual({ trashed: [uuid(1)], refused: [{ id: uuid(2), reason: 'running' }, { id: uuid(3), reason: 'not found' }] });
    expect(d.confirm).toHaveBeenCalledWith(1);
    expect(trashed).toEqual([path.join(dir, `${uuid(1)}.jsonl`)]);
  });

  it('nothing left to trash: no question at all', async () => {
    plant(1);
    const { d, trashed } = deps({ liveIds: vi.fn(async () => [uuid(1)]) });
    expect(await trashConversations([uuid(1), uuid(9)], d)).toEqual({ trashed: [], refused: [{ id: uuid(1), reason: 'running' }, { id: uuid(9), reason: 'not found' }] });
    expect(await trashConversations([], d)).toEqual({ trashed: [], refused: [] });
    expect(await trashConversations('x' as never, d)).toEqual({ trashed: [], refused: [] });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(trashed).toEqual([]);
  });

  it('when the running ones cannot be known, nothing is trashed and nothing asked (never a guess)', async () => {
    plant(1);
    const { d, trashed } = deps({ liveIds: vi.fn(async () => Promise.reject(new Error('the terminal is not running'))) });
    expect(await trashConversations([uuid(1)], d)).toEqual({ trashed: [], refused: [{ id: uuid(1), reason: 'unknown' }] });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(trashed).toEqual([]);
  });

  it('looks again after the question: one resumed meanwhile is refused, one gone meanwhile is not found, a transcript swapped for a link is not trashed', async () => {
    plant(1);
    plant(2);
    plant(3);
    const outside = path.join(env.root, 'outside.jsonl');
    fs.writeFileSync(outside, '{}\n');
    let live: string[] = [];
    const { d, trashed } = deps({
      liveIds: vi.fn(async () => live),
      confirm: vi.fn(async () => {
        live = [uuid(1)];
        fs.rmSync(path.join(dir, `${uuid(2)}.jsonl`));
        fs.rmSync(path.join(dir, `${uuid(3)}.jsonl`));
        fs.symlinkSync(outside, path.join(dir, `${uuid(3)}.jsonl`));
        return true;
      }),
    });
    expect(await trashConversations([uuid(1), uuid(2), uuid(3)], d)).toEqual({
      trashed: [],
      refused: [
        { id: uuid(1), reason: 'running' },
        { id: uuid(2), reason: 'not found' },
        { id: uuid(3), reason: 'not found' },
      ],
    });
    expect(d.confirm).toHaveBeenCalledWith(3);
    expect(trashed).toEqual([]);
  });

  it('takes 200 ids at most', async () => {
    plant(1);
    const { d } = deps();
    const r = await trashConversations([...Array.from({ length: 200 }, (_, i) => uuid(i + 100)), uuid(1)], d);
    expect(r.trashed).toEqual([]);
    expect(r.refused).toHaveLength(200);
  });

  it('the question: a count, what it means, Cancel the default', () => {
    expect(trashAsk(1)).toEqual({
      type: 'warning',
      message: 'Move 1 past conversation to the Trash?',
      detail: 'Claude Code can no longer resume it. You can put it back from the Trash.',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    expect(trashAsk(3)).toMatchObject({ message: 'Move 3 past conversations to the Trash?', detail: 'Claude Code can no longer resume them. You can put them back from the Trash.' });
  });
  it('switched off (1.4.0, permissions.trash): nothing is looked up, asked or moved, and every valid id is refused as off', async () => {
    plant(1);
    const { d, trashed } = deps({ enabled: () => false });
    expect(await trashConversations([uuid(1), uuid(2), '../x'], d)).toEqual({ trashed: [], refused: [{ id: uuid(1), reason: 'off' }, { id: uuid(2), reason: 'off' }] });
    expect(d.liveIds).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(trashed).toEqual([]);
    const on = deps({ enabled: () => true });
    expect((await trashConversations([uuid(1)], on.d)).trashed).toEqual([uuid(1)]);
  });
});
