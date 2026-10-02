/**
 * How open session tabs tile in split view.
 *
 * Four panes per row is the ceiling. A fifth opens a second row and the rows
 * split evenly — 5 reads 3 + 2, 6 reads 3 + 3, 7 reads 4 + 3. Panes never get
 * narrower than a quarter; past four they lose height, not width.
 */

/** Most panes the split grid will hold (two rows of four). */
export const MAX_SPLIT_PANES = 8;

export type PaneDensity = "full" | "compact" | "dense";

export interface SessionPaneLayout {
  track: number;
  spans: number[];
  density: PaneDensity;
  rows: number;
  cols: number;
  rowSizes: number[];
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export function sessionPaneLayout(count: number): SessionPaneLayout {
  const n = Math.max(1, count);
  const rows = Math.ceil(n / 4);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const rowSizes: number[] = [];
  for (let r = 0; r < rows; r += 1) rowSizes.push(base + (r < extra ? 1 : 0));
  const cols = Math.max(...rowSizes);
  const track = rowSizes.reduce((a, b) => (a * b) / gcd(a, b), 1);
  const spans: number[] = [];
  for (const size of rowSizes) {
    for (let i = 0; i < size; i += 1) spans.push(track / size);
  }
  const short = rows >= 2;
  const dense = cols >= 4 || short;
  const compact = !dense && cols === 3;
  const density: PaneDensity = dense ? "dense" : compact ? "compact" : "full";
  return { track, spans, density, rows, cols, rowSizes };
}
