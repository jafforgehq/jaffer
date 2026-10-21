import { describe, expect, it } from 'vitest';
import { cleanPaneLabel, firstPaneId, idleToClose, movePane, reorderPanes } from '../src/shared/pane-tools';

describe('cleanPaneLabel', () => {
  it('drops control and format characters, collapses spaces, trims', () => {
    expect(cleanPaneLabel('  a‮b\n c  ')).toBe('ab c');
    expect(cleanPaneLabel('a\nb\tc')).toBe('a b c'); // (a line break or tab is a space)
  });
  it('clips to 24 code points', () => {
    expect([...cleanPaneLabel('x'.repeat(100))]).toHaveLength(24);
    expect([...cleanPaneLabel('😀'.repeat(100))]).toHaveLength(24);
  });
  it('gives an empty text for only spaces', () => {
    expect(cleanPaneLabel('   ')).toBe('');
  });
  it('gives an empty text for a label of only invisible characters', () => {
    for (const t of ['\u3164', '\u2800', '\u115F\u1160', '\uFFA0 \u3164', '\uFE0F', '\u0301']) expect(cleanPaneLabel(t), JSON.stringify(t)).toBe('');
    expect(cleanPaneLabel('\u3164a')).toBe('a'); // (a filler that draws nothing is dropped)
  });
  it('is bounded on huge input', () => {
    const t = Date.now();
    cleanPaneLabel(' '.repeat(100_000) + 'a');
    cleanPaneLabel('a‮ '.repeat(50_000));
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe('reorderPanes / movePane', () => {
  it('moves id to the index of "to"', () => {
    expect(reorderPanes(['main', 'p2', 'p3'], 'p3', 'main')).toEqual(['p3', 'main', 'p2']);
    expect(reorderPanes(['main', 'p2', 'p3'], 'main', 'p3')).toEqual(['p2', 'p3', 'main']);
  });
  it('leaves the list for an unknown or equal id, and returns a copy', () => {
    const l = ['main', 'p2'];
    expect(reorderPanes(l, 'zzz', 'main')).toEqual(l);
    expect(reorderPanes(l, 'main', 'zzz')).toEqual(l);
    const same = reorderPanes(l, 'p2', 'p2');
    expect(same).toEqual(l);
    expect(same).not.toBe(l);
  });
  it('moves one step and stops at the ends', () => {
    expect(movePane(['main', 'p2', 'p3'], 'p2', -1)).toEqual(['p2', 'main', 'p3']);
    expect(movePane(['main', 'p2', 'p3'], 'p2', 1)).toEqual(['main', 'p3', 'p2']);
    expect(movePane(['main', 'p2'], 'main', -1)).toEqual(['main', 'p2']);
    expect(movePane(['main', 'p2'], 'p2', 1)).toEqual(['main', 'p2']);
    expect(movePane(['main', 'p2'], 'zzz', 1)).toEqual(['main', 'p2']);
  });
});

describe('idleToClose', () => {
  it('lists idle terminals but never the focused or a busy one', () => {
    expect(idleToClose(['main', 'p2', 'p3'], 'p2', (id) => id === 'p3')).toEqual(['main']);
  });
  it('keeps the first when the focused id is unknown', () => {
    expect(idleToClose(['main', 'p2'], 'zzz', () => false)).toEqual(['p2']);
  });
  it('never returns everything', () => {
    expect(idleToClose(['main'], 'main', () => false)).toEqual([]);
  });
});

describe('firstPaneId', () => {
  it('is the first of main, p2, p3, p4 that exists, whatever the order of the list', () => {
    expect(firstPaneId(['p3', 'main', 'p2'])).toBe('main');
    expect(firstPaneId(['p4', 'p3', 'p2'])).toBe('p2');
    expect(firstPaneId(['p4'])).toBe('p4');
  });
  it('is main for an empty list', () => {
    expect(firstPaneId([])).toBe('main');
  });
});
