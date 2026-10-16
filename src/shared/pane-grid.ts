/** At most this many terminals in the window (the daemon refuses a fifth too). */
export const MAX_PANES = 4;

/** Where one terminal sits in the split view's grid: its column, its first row and how many rows it spans (grid lines count from 1). */
export interface PaneCell {
  col: number;
  row: number;
  rows: number;
}

/**
 * The split view (1.4.0): equal parts, no drag. One terminal fills the card; two sit side by side; three are one on the left and two
 * stacked on the right; four are 2×2. The cells are in the order the terminals were opened.
 */
export function paneGrid(count: number): { cols: number; rows: number; cells: PaneCell[] } {
  const n = Math.min(MAX_PANES, Math.max(1, Math.floor(count) || 1));
  if (n === 1) return { cols: 1, rows: 1, cells: [{ col: 1, row: 1, rows: 1 }] };
  if (n === 2) return { cols: 2, rows: 1, cells: [{ col: 1, row: 1, rows: 1 }, { col: 2, row: 1, rows: 1 }] };
  if (n === 3) return { cols: 2, rows: 2, cells: [{ col: 1, row: 1, rows: 2 }, { col: 2, row: 1, rows: 1 }, { col: 2, row: 2, rows: 1 }] };
  return { cols: 2, rows: 2, cells: [{ col: 1, row: 1, rows: 1 }, { col: 2, row: 1, rows: 1 }, { col: 1, row: 2, rows: 1 }, { col: 2, row: 2, rows: 1 }] };
}
