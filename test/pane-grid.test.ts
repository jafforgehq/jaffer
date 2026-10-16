import { describe, expect, it } from 'vitest';
import { MAX_PANES, paneGrid } from '../src/shared/pane-grid';

/** The split view (1.4.0): up to four terminals in a grid of equal parts, no drag. */
describe('paneGrid', () => {
  it('one terminal fills the card; two side by side; three: one left, two stacked right; four: 2×2', () => {
    expect(paneGrid(1)).toEqual({ cols: 1, rows: 1, cells: [{ col: 1, row: 1, rows: 1 }] });
    expect(paneGrid(2)).toEqual({ cols: 2, rows: 1, cells: [{ col: 1, row: 1, rows: 1 }, { col: 2, row: 1, rows: 1 }] });
    expect(paneGrid(3)).toEqual({ cols: 2, rows: 2, cells: [{ col: 1, row: 1, rows: 2 }, { col: 2, row: 1, rows: 1 }, { col: 2, row: 2, rows: 1 }] });
    expect(paneGrid(4)).toEqual({ cols: 2, rows: 2, cells: [{ col: 1, row: 1, rows: 1 }, { col: 2, row: 1, rows: 1 }, { col: 1, row: 2, rows: 1 }, { col: 2, row: 2, rows: 1 }] });
  });

  it('the cells tile the grid exactly once each, for every count', () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      const g = paneGrid(n);
      const taken = new Set<string>();
      for (const c of g.cells) for (let r = c.row; r < c.row + c.rows; r++) {
        const k = `${c.col},${r}`;
        expect(taken.has(k), `cell ${k} of ${n}`).toBe(false);
        taken.add(k);
      }
      expect(taken.size, `${n} terminals fill the grid`).toBe(g.cols * g.rows);
      expect(g.cells).toHaveLength(n);
    }
  });

  it('a count out of range is clamped to 1..4', () => {
    expect(MAX_PANES).toBe(4);
    expect(paneGrid(0)).toEqual(paneGrid(1));
    expect(paneGrid(9)).toEqual(paneGrid(4));
    expect(paneGrid(Number.NaN)).toEqual(paneGrid(1));
  });
});
