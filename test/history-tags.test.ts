import { describe, expect, it } from 'vitest';
import { addTag, allTags, cleanTag, dropTags, hiddenIds, MAX_HIDDEN, MAX_TAG_ENTRIES, parseTags, removeTag, tagColor, tagsOf, toggleHidden } from '../src/shared/history-tags';

const id = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';

describe('tags of past conversations (1.4.0): `history.tags`, "<uuid> <tag>" in a list of text', () => {
  it('cleanTag: control and format characters go, whitespace collapses, at most 20 characters, no space at either end, nothing left is empty', () => {
    expect(cleanTag('  bug\tfix\n ')).toBe('bug fix');
    expect(cleanTag('a\x1b\x07​‮b')).toBe('a b');
    expect(cleanTag('x'.repeat(19) + ' tail')).toBe('x'.repeat(19)); // (cut at 20, then the space at the end goes)
    expect(Array.from(cleanTag('😀'.repeat(50)))).toHaveLength(20);
    for (const empty of ['', '   ', '\x00', '​', 5, null, undefined, {}]) expect(cleanTag(empty), JSON.stringify(empty)).toBe('');
  });

  it('parseTags: id → tags; hostile entries (not text, bad id, no tag, a fourth tag, the same tag in another case) are skipped; only the first 400 entries are read', () => {
    const m = parseTags([`${id(1)} work`, 'junk', 7, null, `${id(2)}`, `${id(3)}   `, `../${id(4)} x`, `${id(1)} WORK`, `${id(1)}  urgent  now `, `${id(1)} b`, `${id(1)} fourth`, `${id(5)}x nospace`] as never);
    expect([...m]).toEqual([[id(1), ['work', 'urgent now', 'b']]]);
    for (const bad of [undefined, null, 'text', 5, {}]) expect(parseTags(bad as never).size).toBe(0);
    const big = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666 t`);
    expect(parseTags(big).size).toBe(MAX_TAG_ENTRIES);
    expect(tagsOf([`${id(1)} a`, `${id(2)} b`], id(2))).toEqual(['b']);
    expect(tagsOf([], id(2))).toEqual([]);
  });

  it('addTag: cleans it, at most 3 per conversation (null: refused), the same tag in any case once, at most 400 entries in all, a bad id or an empty tag changes nothing', () => {
    let l = addTag([], id(1), ' Work ')!;
    l = addTag(l, id(1), 'urgent')!;
    expect(l).toEqual([`${id(1)} Work`, `${id(1)} urgent`]);
    expect(addTag(l, id(1), 'work')).toEqual(l); // (already there)
    l = addTag(l, id(1), 'c')!;
    expect(addTag(l, id(1), 'fourth')).toBeNull();
    expect(addTag(l, 'nope', 'x')).toEqual(l);
    expect(addTag(l, id(2), '  \n')).toEqual(l);
    expect(addTag(['junk', `${id(1)} a`] as never, id(2), 'b')).toEqual([`${id(1)} a`, `${id(2)} b`]); // (a bad entry is dropped on the next write)
    const full = Array.from({ length: MAX_TAG_ENTRIES }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666 t`);
    expect(addTag(full, id(9999), 'x')).toBeNull();
  });

  it('removeTag (any case) and dropTags (the conversations moved to the Trash)', () => {
    const l = [`${id(1)} Work`, `${id(1)} b`, `${id(2)} work`];
    expect(removeTag(l, id(1), 'WORK')).toEqual([`${id(1)} b`, `${id(2)} work`]);
    expect(removeTag(l, id(3), 'work')).toEqual(l);
    expect(dropTags(l, [id(1)])).toEqual([`${id(2)} work`]);
  });

  it('allTags: each tag once (any case, the first spelling), with how many conversations carry it, most used first', () => {
    expect(allTags([`${id(1)} Work`, `${id(2)} work`, `${id(2)} zeta`, `${id(3)} alpha`, `${id(3)} WORK`])).toEqual([
      { tag: 'Work', count: 3 },
      { tag: 'alpha', count: 1 },
      { tag: 'zeta', count: 1 },
    ]);
    expect(allTags(undefined)).toEqual([]);
  });

  it('tagColor: one of 6, the same for the same name in any case', () => {
    const seen = new Set<number>();
    for (const t of ['work', 'bug', 'idea', 'later', 'x', 'release', 'ops', 'docs', 'ui', 'perf']) {
      const c = tagColor(t);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(6);
      expect(tagColor(t.toUpperCase())).toBe(c);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('hidden past conversations (1.4.0): `history.hidden`, a list of ids', () => {
  it('hiddenIds: valid ids, each once, at most 500', () => {
    expect(hiddenIds([id(1), 'junk', 3, id(1), `${id(2)} x`, id(2)] as never)).toEqual([id(1), id(2)]);
    expect(hiddenIds('nope' as never)).toEqual([]);
    expect(hiddenIds(Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`))).toHaveLength(MAX_HIDDEN);
  });

  it('toggleHidden: hidden → shown, else hidden first; null when 500 are hidden; a bad id changes nothing', () => {
    expect(toggleHidden([id(1)], id(2))).toEqual([id(2), id(1)]);
    expect(toggleHidden([id(1), id(2)], id(1))).toEqual([id(2)]);
    expect(toggleHidden([id(1)], '../x')).toEqual([id(1)]);
    const full = Array.from({ length: MAX_HIDDEN }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`);
    expect(toggleHidden(full, id(99999))).toBeNull();
    expect(toggleHidden(full, full[3]!)).toHaveLength(MAX_HIDDEN - 1);
  });
});
