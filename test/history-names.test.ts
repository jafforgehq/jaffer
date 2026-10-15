import { describe, expect, it } from 'vitest';
import { cleanName, parseNames, pinnedIds, removeName, setName, togglePin } from '../src/shared/history-names';

const id = (n: number) => `0000000${n}`.slice(-8) + '-1111-4222-8333-444455556666';

describe('names of past conversations (1.2.0): `history.names`, "<uuid> <name>" in a list of text', () => {
  it('cleanName: control and format characters go, whitespace collapses to one space, at most 80 characters, nothing left is empty', () => {
    expect(cleanName('  Fix   the\tlogin\nbug  ')).toBe('Fix the login bug');
    expect(cleanName('a\x1b[31mred\x07​‮b')).toBe('a [31mred b'); // (ESC and BEL are spaces, the zero-width and bidi marks gone)
    expect(cleanName('é'.repeat(100))).toBe('é'.repeat(80));
    expect(Array.from(cleanName('😀'.repeat(100)))).toHaveLength(80); // (characters, not UTF-16 units)
    for (const empty of ['', '   ', '\x00\x01', '​', 5, null, undefined, {}]) expect(cleanName(empty), JSON.stringify(empty)).toBe('');
  });

  it('parseNames: a map of id → name; bad entries (not text, no valid id, no name) are skipped; the first entry of an id wins', () => {
    const m = parseNames([`${id(1)} Login bug`, 'nonsense', `${id(2)}`, `${id(3)}    `, 42, null, `../${id(4)} x`, `${id(5)}  spaced   out `, `${id(1)} older name`, `${id(6)}x no space`] as never);
    expect([...m]).toEqual([
      [id(1), 'Login bug'],
      [id(5), 'spaced out'],
    ]);
    for (const bad of [undefined, null, 'a string', 5, {}]) expect(parseNames(bad as never).size).toBe(0);
  });

  it('setName puts the name first (newest first), replaces an older one, cleans it, keeps at most 200, and an empty name removes it', () => {
    let list = setName([], id(1), 'one');
    list = setName(list, id(2), '  two  ');
    expect(list).toEqual([`${id(2)} two`, `${id(1)} one`]);
    list = setName(list, id(1), 'uno');
    expect(list).toEqual([`${id(1)} uno`, `${id(2)} two`]);
    expect(setName(list, id(1), ' \n ')).toEqual([`${id(2)} two`]);
    expect(removeName(list, id(2))).toEqual([`${id(1)} uno`]);
    expect(setName(list, 'not-an-id', 'x')).toEqual(list); // (refused)
    expect(setName(['junk', `${id(1)} a`] as never, id(2), 'b')).toEqual([`${id(2)} b`, `${id(1)} a`]); // (a bad entry is dropped on the next write)
    let many: string[] = [];
    for (let i = 0; i < 230; i++) many = setName(many, `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, `n${i}`);
    expect(many).toHaveLength(200);
    expect(many[0]).toBe(`00000229-1111-4222-8333-444455556666 n229`);
    expect(parseNames(many).size).toBe(200);
  });

  it('a hostile list stays quick and bounded: 1 MB and 8 MB entries, a million entries', () => {
    const big = `${id(1)} ${'x'.repeat(8 * 1024 * 1024)}`;
    let t = performance.now();
    expect(parseNames([big, ` ${'​'.repeat(1 << 20)}`]).get(id(1))).toBe('x'.repeat(80));
    expect(cleanName(' \t'.repeat(1 << 20) + 'end')).toBe('');
    expect(performance.now() - t).toBeLessThan(500);
    t = performance.now();
    const huge = Array.from({ length: 1_000_000 }, (_, i) => (i === 999_999 ? `${id(9)} last` : 'junk'));
    expect(parseNames(huge).has(id(9))).toBe(false); // (only the first 200 entries are looked at: a real list never has more)
    expect(pinnedIds(huge)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('pinned past conversations (1.2.0): `history.pinned`, a list of ids', () => {
  it('pinnedIds: valid, unique ids, at most 50; anything else is skipped', () => {
    expect(pinnedIds([id(1), 'x', id(1), 7, id(2)] as never)).toEqual([id(1), id(2)]);
    expect(pinnedIds('nope' as never)).toEqual([]);
    expect(pinnedIds(Array.from({ length: 80 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`))).toHaveLength(50);
  });

  it('togglePin pins (first) and unpins; a bad id changes nothing; the 51st is refused (null)', () => {
    expect(togglePin([], id(1))).toEqual([id(1)]);
    expect(togglePin([id(1)], id(2))).toEqual([id(2), id(1)]);
    expect(togglePin([id(2), id(1)], id(2))).toEqual([id(1)]);
    expect(togglePin([id(1)], 'x; rm -rf ~')).toEqual([id(1)]);
    const full = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`);
    expect(togglePin(full, id(99))).toBeNull();
    expect(togglePin(full, full[3]!)).toHaveLength(49); // (unpinning still works)
  });
});
