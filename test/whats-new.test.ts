import { describe, expect, it } from 'vitest';
import { effectiveSeen, SEEN_BEFORE_NOTES, unseenNotes } from '../src/shared/whats-new';

const notes = (...v: string[]) => v.map((version) => ({ version, md: `notes ${version}` }));

describe('what is new: which notes are unseen', () => {
  it('versions are compared as numbers: 1.10.0 is newer than 1.9.0', () => {
    expect(unseenNotes(notes('1.10.0', '1.9.0'), '1.9.0', '1.10.0').map((n) => n.version)).toEqual(['1.10.0']);
    expect(unseenNotes(notes('1.10.0', '1.9.0'), '1.10.0', '1.10.0')).toEqual([]);
  });

  it('shows what came after the seen version, up to the running one, newest first', () => {
    const all = notes('1.3.0', '1.2.0', '1.1.1', '1.1.0');
    expect(unseenNotes(all, '1.1.1', '1.3.0').map((n) => n.version)).toEqual(['1.3.0', '1.2.0']);
    expect(unseenNotes(all, '1.1.1', '1.2.0').map((n) => n.version)).toEqual(['1.2.0']); // (notes of a version that is not running yet are not shown)
  });

  it('nothing is unseen when the seen version is the running one or newer, or when it is not a version at all', () => {
    expect(unseenNotes(notes('1.2.0'), '1.2.0', '1.2.0')).toEqual([]);
    expect(unseenNotes(notes('1.2.0'), '1.3.0', '1.2.0')).toEqual([]);
    expect(unseenNotes(notes('1.2.0'), 'junk', '1.2.0')).toEqual([]);
    expect(unseenNotes(notes('1.2.0'), '', '1.2.0')).toEqual([]);
  });

  it('at most the 5 newest are shown', () => {
    const all = notes('1.7.0', '1.6.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0');
    expect(unseenNotes(all, '1.0.0', '1.7.0').map((n) => n.version)).toEqual(['1.7.0', '1.6.0', '1.5.0', '1.4.0', '1.3.0']);
  });

  it('the seen version: the one written, else 1.1.1 on a Mac that ran Jaffer before, else the running version (a first start sees nothing)', () => {
    expect(SEEN_BEFORE_NOTES).toBe('1.1.1');
    expect(effectiveSeen({ seenVersion: '1.2.0', onboarded: true }, '1.3.0')).toBe('1.2.0');
    expect(effectiveSeen({ seenVersion: '', onboarded: true }, '1.3.0')).toBe('1.1.1');
    expect(effectiveSeen({ seenVersion: '', onboarded: false }, '1.3.0')).toBe('1.3.0');
    expect(effectiveSeen(undefined, '1.3.0')).toBe('1.3.0');
  });
});
