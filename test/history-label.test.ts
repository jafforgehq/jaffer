import { describe, expect, it } from 'vitest';
import { fmtAgo, historyMenuItems, resumeCommand, tildeOf } from '../src/shared/history-label';

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
