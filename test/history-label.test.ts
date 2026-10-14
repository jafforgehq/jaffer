import { describe, expect, it } from 'vitest';
import { conversationRow, filterByFolder, fmtAgo, groupByDay, historyMenuItems, resumeCommand, tildeOf } from '../src/shared/history-label';

const id = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';
const NOW = Date.parse('2026-10-14T12:00:00Z');

describe('past conversations: the pieces both the window and the menu bar use', () => {
  it('resumeCommand is `claude --resume <id>` for a session id and nothing for anything else (it ends up on a command line)', () => {
    expect(resumeCommand(id(1))).toBe(`claude --resume ${id(1)}`);
    for (const bad of ['', 'abc', `${id(1)}; rm -rf ~`, `${id(1)}\n`, '$(touch x)']) expect(resumeCommand(bad), JSON.stringify(bad)).toBeNull();
  });

  it('tildeOf shortens the home folder only at a folder boundary', () => {
    expect(tildeOf('/Users/maya/code/api', '/Users/maya')).toBe('~/code/api');
    expect(tildeOf('/Users/maya', '/Users/maya')).toBe('~');
    expect(tildeOf('/Users/mayaX/code', '/Users/maya')).toBe('/Users/mayaX/code');
    expect(tildeOf('/tmp/x', '')).toBe('/tmp/x');
  });

  it('fmtAgo reads as just now / minutes / hours / days', () => {
    expect(fmtAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(fmtAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(fmtAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(fmtAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });

  it('historyMenuItems: the 5 newest with a valid id, "<folder> · <ago>", one line, at most 60 characters', () => {
    const items = [
      { id: id(1), cwd: '/Users/maya/code/api', endedAt: NOW - 60_000 },
      { id: 'not-an-id', cwd: '/Users/maya/code/bad', endedAt: NOW - 90_000 },
      { id: id(2), cwd: '/Users/maya', endedAt: NOW - 3 * 3_600_000 },
      { id: id(3), endedAt: NOW - 86_400_000 * 2 },
      { id: id(4), cwd: `/Users/maya/${'long-'.repeat(30)}`, endedAt: NOW },
      { id: id(5), cwd: '/srv/a', endedAt: NOW },
      { id: id(6), cwd: '/srv/b', endedAt: NOW },
      { id: id(7), cwd: '/srv/c', endedAt: NOW },
    ];
    const out = historyMenuItems(items, '/Users/maya', NOW);
    expect(out.map((m) => m.id)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(out[0]!.label).toBe('api · 1m ago');
    expect(out[1]!.label).toBe('~ · 3h ago');
    expect(out[2]!.label).toBe('Conversation · 2d ago'); // no folder known
    expect(out[3]!.label.length).toBeLessThanOrEqual(60);
    expect(out[3]!.label.endsWith('…')).toBe(true);
    expect(historyMenuItems([], '/h', NOW)).toEqual([]);
    expect(historyMenuItems('nope' as never, '/h', NOW)).toEqual([]);
  });
});

describe('past conversations in the side panel (1.1.0): days, the folder filter, the rows', () => {
  // local times (the day labels follow the Mac's own midnight): 14 Oct 2026 is a Wednesday
  const at = (d: number, h: number, m = 0, s = 0, mo = 9, y = 2026) => new Date(y, mo, d, h, m, s).getTime();
  const NOW_L = at(14, 12);
  const c = (n: number, endedAt: number, cwd?: string) => ({ id: id(n), cwd, endedAt });

  it('groupByDay: Today, Yesterday, then "Mon 12 Oct" from the local date, split at local midnight, newest first', () => {
    const groups = groupByDay([c(1, at(14, 0, 0, 1)), c(2, at(13, 23, 59, 59)), c(3, at(14, 11)), c(4, at(13, 0, 0, 0)), c(5, at(12, 23, 59)), c(6, at(5, 9))], NOW_L);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Mon 12 Oct', 'Mon 5 Oct']);
    expect(groups.map((g) => g.items.map((x) => x.id))).toEqual([[id(3), id(1)], [id(2), id(4)], [id(5)], [id(6)]]);
  });

  it('groupByDay: a day in another year says the year; across a month and a year boundary Yesterday is still the day before', () => {
    expect(groupByDay([c(1, at(31, 20, 0, 0, 11, 2025))], at(1, 8, 0, 0, 0, 2026)).map((g) => g.label)).toEqual(['Yesterday']);
    expect(groupByDay([c(1, at(30, 20, 0, 0, 11, 2025))], at(1, 8, 0, 0, 0, 2026)).map((g) => g.label)).toEqual(['Tue 30 Dec 2025']);
    expect(groupByDay([c(1, at(30, 20, 0, 0, 8))], NOW_L).map((g) => g.label)).toEqual(['Wed 30 Sep']);
  });

  it('groupByDay: nothing gives no groups; odd times go last under "Earlier", nothing is dropped', () => {
    expect(groupByDay([], NOW_L)).toEqual([]);
    expect(groupByDay('nope' as never, NOW_L)).toEqual([]);
    const g = groupByDay([c(1, NaN), c(2, at(14, 9)), { id: id(3), endedAt: 'x' as never }], NOW_L);
    expect(g.map((x) => [x.label, x.items.length])).toEqual([['Today', 1], ['Earlier', 2]]);
  });

  it('filterByFolder: the ~ path holds the text, any case; an empty filter keeps all, a conversation without a folder only then', () => {
    const items = [c(1, NOW_L, '/Users/maya/code/API'), c(2, NOW_L, '/Users/maya/notes'), c(3, NOW_L), c(4, NOW_L, '/srv/api-old')];
    expect(filterByFolder(items, 'api', '/Users/maya').map((x) => x.id)).toEqual([id(1), id(4)]);
    expect(filterByFolder(items, '  ~/code ', '/Users/maya').map((x) => x.id)).toEqual([id(1)]);
    expect(filterByFolder(items, '', '/Users/maya')).toHaveLength(4);
    expect(filterByFolder(items, 'zzz', '/Users/maya')).toEqual([]);
  });

  it('conversationRow: the folder name, its ~ path, the time of day, how long, and the cost only when shown', () => {
    const r = conversationRow({ id: id(1), cwd: '/Users/maya/code/api', endedAt: at(14, 9, 5), durMs: 90_000, usd: 0.4216 }, '/Users/maya', true);
    expect(r).toEqual({ name: 'api', dir: '~/code/api', time: '09:05', dur: '1m 30s', cost: '≈ $0.42' });
    expect(conversationRow({ id: id(1), cwd: '/Users/maya', endedAt: at(14, 23, 59) }, '/Users/maya', true)).toEqual({ name: '~', dir: '~', time: '23:59', dur: '–', cost: '–' });
    expect(conversationRow({ id: id(1), endedAt: at(14, 0, 7), usd: 1 }, '/h', false)).toEqual({ name: '(folder unknown)', dir: '', time: '00:07', dur: '–', cost: null });
    expect(conversationRow({ id: id(1), cwd: '/', endedAt: NaN }, '/h', true).time).toBe('–');
  });
});
