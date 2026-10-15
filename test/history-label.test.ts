import { describe, expect, it } from 'vitest';
import { conversationName, conversationRow, costByFolder, filterByFolder, fmtAgo, freshList, groupByDay, groupConversations, historyMenuItems, lastConversation, paletteConversations, resumeCommand, tildeOf, topFolders } from '../src/shared/history-label';

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

  it('historyMenuItems with titles (1.1.1): the title clipped to 40 instead of the folder; without one, the folder as before', () => {
    const out = historyMenuItems(
      [
        { id: id(1), cwd: '/Users/maya', endedAt: NOW - 60_000, title: 'Fix the login bug' },
        { id: id(2), cwd: '/Users/maya/code/api', endedAt: NOW - 60_000, title: `Refactor ${'the whole thing '.repeat(10)}` },
        { id: id(3), cwd: '/Users/maya/code/api', endedAt: NOW - 60_000, title: '' },
      ],
      '/Users/maya',
      NOW,
    );
    expect(out[0]!.label).toBe('Fix the login bug · 1m ago');
    expect(out[1]!.label).toBe(`${'Refactor the whole thing the whole thing the whole thing'.slice(0, 39)}… · 1m ago`);
    expect(out[2]!.label).toBe('api · 1m ago');
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

  it('filterByFolder matches the title too (1.1.1), any case; a conversation without a folder is found by its title', () => {
    const items = [{ ...c(1, NOW_L, '/Users/maya/notes'), title: 'Fix the LOGIN bug' }, { ...c(2, NOW_L), title: 'login page copy' }, c(3, NOW_L, '/srv/api')];
    expect(filterByFolder(items, 'login', '/Users/maya').map((x) => x.id)).toEqual([id(1), id(2)]);
    expect(filterByFolder(items, 'api', '/Users/maya').map((x) => x.id)).toEqual([id(3)]);
  });

  it('conversationRow: the folder name, its ~ path, the time of day, how long, and the cost only when shown', () => {
    const r = conversationRow({ id: id(1), cwd: '/Users/maya/code/api', endedAt: at(14, 9, 5), durMs: 90_000, usd: 0.4216 }, '/Users/maya', true);
    expect(r).toEqual({ name: 'api', dir: '~/code/api', time: '09:05', dur: '1m 30s', cost: '≈ $0.42' });
    expect(conversationRow({ id: id(1), cwd: '/Users/maya', endedAt: at(14, 23, 59) }, '/Users/maya', true)).toEqual({ name: '~', dir: '~', time: '23:59', dur: '–', cost: '–' });
    expect(conversationRow({ id: id(1), endedAt: at(14, 0, 7), usd: 1 }, '/h', false)).toEqual({ name: '(folder unknown)', dir: '', time: '00:07', dur: '–', cost: null });
    expect(conversationRow({ id: id(1), cwd: '/', endedAt: NaN }, '/h', true).time).toBe('–');
  });
});

describe('past conversations, 1.2.0: names, pins, folder chips, cost by folder, the last one, the palette', () => {
  const at = (d: number, h: number, m = 0, s = 0, mo = 9, y = 2026) => new Date(y, mo, d, h, m, s).getTime();
  const NOW_L = at(14, 12);
  const HOME = '/Users/maya';

  it('conversationName: the person’s own name wins over the title, then the title, then "Conversation"', () => {
    const names = new Map([[id(1), 'My name']]);
    expect(conversationName({ id: id(1), title: 'Claude title' }, names)).toBe('My name');
    expect(conversationName({ id: id(2), title: 'Claude title' }, names)).toBe('Claude title');
    expect(conversationName({ id: id(2), title: '' }, names)).toBe('Conversation');
    expect(conversationName({ id: id(2) })).toBe('Conversation');
  });

  it('the name wins in the menu bar labels (clipped to 40) and the search finds it', () => {
    const names = new Map([[id(1), 'Renamed by me']]);
    const items = [{ id: id(1), cwd: `${HOME}/code/api`, endedAt: NOW - 60_000, title: 'Claude title' }, { id: id(2), cwd: `${HOME}/notes`, endedAt: NOW - 60_000, title: 'Other' }];
    expect(historyMenuItems(items, HOME, NOW, names).map((m) => m.label)).toEqual(['Renamed by me · 1m ago', 'Other · 1m ago']);
    expect(historyMenuItems(items, HOME, NOW).map((m) => m.label)).toEqual(['Claude title · 1m ago', 'Other · 1m ago']);
    expect(historyMenuItems([items[0]!], HOME, NOW, new Map([[id(1), 'x'.repeat(80)]]))[0]!.label).toBe(`${'x'.repeat(39)}… · 1m ago`);
    expect(filterByFolder(items, 'RENAMED', HOME, names).map((c) => c.id)).toEqual([id(1)]);
    expect(filterByFolder(items, 'claude title', HOME, names).map((c) => c.id)).toEqual([id(1)]); // (the title still counts)
  });

  it('groupConversations: the pinned ones (newest first) in a "Pinned" group above the days, and not again in their day', () => {
    const items = [{ id: id(1), endedAt: at(14, 9) }, { id: id(2), endedAt: at(13, 9) }, { id: id(3), endedAt: at(1, 9) }, { id: id(4), endedAt: at(14, 10) }];
    const g = groupConversations(items, NOW_L, [id(3), id(1), 'junk']);
    expect(g.map((x) => [x.label, x.items.map((c) => c.id)])).toEqual([
      ['Pinned', [id(1), id(3)]],
      ['Today', [id(4)]],
      ['Yesterday', [id(2)]],
    ]);
    expect(groupConversations(items, NOW_L, []).map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Thu 1 Oct']);
  });

  it('topFolders: the 5 folders with the most conversations (ties: the newest first), by their short name with the ~ path; none without a folder', () => {
    const items = [
      ...[1, 2, 3].map((n) => ({ id: id(n), cwd: `${HOME}/code/api`, endedAt: at(10, n) })),
      ...[4, 5].map((n) => ({ id: id(n), cwd: '/srv/web', endedAt: at(10, n) })),
      { id: id(6), cwd: HOME, endedAt: at(12, 1) },
      { id: id(7), cwd: '/a', endedAt: at(11, 1) },
      { id: id(8), cwd: '/b', endedAt: at(13, 1) },
      { id: id(9), cwd: '/c', endedAt: at(9, 1) },
      { id: id(10), endedAt: at(14, 1) },
    ];
    expect(topFolders(items, HOME)).toEqual([
      { cwd: `${HOME}/code/api`, label: 'api', dir: '~/code/api' },
      { cwd: '/srv/web', label: 'web', dir: '/srv/web' },
      { cwd: '/b', label: 'b', dir: '/b' },
      { cwd: HOME, label: '~', dir: '~' },
      { cwd: '/a', label: 'a', dir: '/a' },
    ]);
    expect(topFolders([], HOME)).toEqual([]);
    expect(topFolders('nope' as never, HOME)).toEqual([]);
  });

  it('costByFolder: today (since local midnight) and this week (the last 7 days) per folder, from the conversations with a cost; the top 5 by the week', () => {
    const midnight = at(14, 0);
    const items = [
      { id: id(1), cwd: `${HOME}/api`, endedAt: midnight, usd: 1 }, // today, just
      { id: id(2), cwd: `${HOME}/api`, endedAt: midnight - 1, usd: 2 }, // yesterday: the week only
      { id: id(3), cwd: `${HOME}/api`, endedAt: NOW_L - 7 * 86_400_000, usd: 50 }, // exactly 7 days ago: out
      { id: id(4), cwd: `${HOME}/api`, endedAt: NOW_L - 7 * 86_400_000 + 1, usd: 4 }, // just inside the week
      { id: id(5), cwd: '/srv/web', endedAt: NOW_L, usd: 0.5 },
      { id: id(6), cwd: '/srv/web', endedAt: NOW_L + 60_000, usd: 9 }, // in the future (a clock off): out
      { id: id(7), cwd: '/srv/free', endedAt: NOW_L }, // no cost known
      { id: id(8), endedAt: NOW_L, usd: 3 }, // no folder
      ...[1, 2, 3, 4, 5].map((n) => ({ id: id(10 + n), cwd: `/x/${n}`, endedAt: NOW_L - 3_600_000, usd: n / 100 })),
    ];
    expect(costByFolder(items, NOW_L, HOME)).toEqual([
      { cwd: `${HOME}/api`, dir: '~/api', today: 1, week: 7 },
      { cwd: '/srv/web', dir: '/srv/web', today: 0.5, week: 0.5 },
      { cwd: '/x/5', dir: '/x/5', today: 0.05, week: 0.05 },
      { cwd: '/x/4', dir: '/x/4', today: 0.04, week: 0.04 },
      { cwd: '/x/3', dir: '/x/3', today: 0.03, week: 0.03 },
    ]);
    expect(costByFolder([], NOW_L, HOME)).toEqual([]);
    expect(costByFolder([{ cwd: '/a', endedAt: NOW_L, usd: NaN }], NOW_L, HOME)).toEqual([]);
  });

  it('lastConversation: the newest in the shell’s folder, else the newest of all; a bad id never', () => {
    const items = [
      { id: id(1), cwd: '/a', endedAt: at(14, 9) },
      { id: 'x; rm -rf ~', cwd: '/b', endedAt: at(14, 11) },
      { id: id(2), cwd: '/b', endedAt: at(13, 9) },
      { id: id(3), cwd: '/b', endedAt: at(12, 9) },
      { id: id(4), cwd: '/c', endedAt: at(14, 10) },
    ];
    expect(lastConversation(items, '/b')?.id).toBe(id(2));
    expect(lastConversation(items, '/elsewhere')?.id).toBe(id(4));
    expect(lastConversation(items, '')?.id).toBe(id(4));
    expect(lastConversation([], '/b')).toBeUndefined();
    expect(lastConversation([{ id: 'bad', endedAt: 1 }], '/b')).toBeUndefined();
  });

  it('paletteConversations: from 2 typed characters, at most 5 whose name, title or folder match', () => {
    const names = new Map([[id(1), 'Deploy fixes']]);
    const items = Array.from({ length: 8 }, (_, i) => ({ id: id(i + 1), cwd: `${HOME}/proj-${i}`, endedAt: NOW - i, title: `Title ${i}` }));
    expect(paletteConversations(items, 'd', HOME, names)).toEqual([]);
    expect(paletteConversations(items, ' deploy ', HOME, names).map((c) => c.id)).toEqual([id(1)]);
    expect(paletteConversations(items, 'proj-3', HOME, names).map((c) => c.id)).toEqual([id(4)]);
    expect(paletteConversations(items, 'title', HOME, names)).toHaveLength(5);
    expect(paletteConversations(null, 'title', HOME, names)).toEqual([]);
  });
});

describe('past conversations, 1.2.0 review fixes: a fresh list for ⇧⌘R, unique rows, chips that tell folders apart, palette titles', () => {
  const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();

  it('freshList: the list just read, whatever was cached (none, or an older one); a failed read falls back to the cached list, else says why', async () => {
    const older = [{ id: id(1), endedAt: at(14, 9) }];
    const newer = [{ id: id(2), endedAt: at(14, 11) }, ...older];
    expect(await freshList(async () => newer, null)).toEqual({ items: newer });
    expect(await freshList(async () => newer, older)).toEqual({ items: newer });
    expect(await freshList(async () => Promise.reject(new Error('daemon away')), older)).toEqual({ items: older, error: 'daemon away' });
    expect(await freshList(async () => Promise.reject(new Error('daemon away')), null)).toEqual({ items: null, error: 'daemon away' });
    expect(await freshList(async () => Promise.reject('odd'), null)).toEqual({ items: null, error: 'Could not read the past conversations.' });
  });

  it('groupConversations shows a conversation once, even when the list has it twice (pinned or not)', () => {
    const items = [{ id: id(1), endedAt: at(14, 9) }, { id: id(1), endedAt: at(13, 9) }, { id: id(2), endedAt: at(14, 8) }, { id: id(2), endedAt: at(14, 7) }];
    const ids = (pinned: string[]) => groupConversations(items, at(14, 12), pinned).flatMap((g) => g.items.map((c) => c.id));
    expect(ids([])).toEqual([id(1), id(2)]);
    expect(ids([id(1)])).toEqual([id(1), id(2)]);
  });

  it('topFolders: two folders with the same short name show their ~ paths instead', () => {
    const items = [
      { id: id(1), cwd: '/Users/maya/a/api', endedAt: at(14, 9) },
      { id: id(2), cwd: '/Users/maya/b/api', endedAt: at(14, 8) },
      { id: id(3), cwd: '/srv/web', endedAt: at(14, 7) },
    ];
    expect(topFolders(items, '/Users/maya').map((f) => f.label)).toEqual(['~/a/api', '~/b/api', 'web']);
  });

  it('conversationName with a home: no name and no title gives the folder (as shown, with ~), then "Conversation"', () => {
    expect(conversationName({ id: id(1), cwd: '/Users/maya/code/api' }, new Map(), '/Users/maya')).toBe('~/code/api');
    expect(conversationName({ id: id(1), cwd: '/Users/maya/code/api', title: 'T' }, new Map(), '/Users/maya')).toBe('T');
    expect(conversationName({ id: id(1) }, new Map(), '/Users/maya')).toBe('Conversation');
    expect(conversationName({ id: id(1), cwd: '/x' })).toBe('Conversation'); // (the panel's rows show the folder on their own line)
  });
});
