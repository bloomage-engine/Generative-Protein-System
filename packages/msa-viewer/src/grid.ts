import type { MsaSequence } from "./formats.js";
import { isConservedCol, type ColumnStat, type ConservedOptions } from "./stats.js";

export interface Span {
  text: string;
  cls: string;
}

export interface RowWindow {
  start: number;
  count: number;
}

/** The (inclusive) window of rows to render: visible plus overscan, clamped. */
export function rowWindow(
  totalRows: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscanRows: number = 4,
): RowWindow {
  if (totalRows <= 0 || rowHeight <= 0) return { start: 0, count: 0 };
  let start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  if (start > totalRows) start = totalRows;
  const count = Math.min(totalRows - start, Math.ceil(viewportHeight / rowHeight) + overscanRows * 2);
  return { start, count: Math.max(0, count) };
}

/** Merge consecutive same-class characters into runs (minimum run length 1). */
export function groupSpans(text: string, classify: (index: number) => string): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const cls = classify(i);
    let j = i + 1;
    while (j < text.length && classify(j) === cls) j++;
    out.push({ text: text.slice(i, j), cls });
    i = j;
  }
  return out;
}

/** Classic alignment ruler: the 1..9/0 cycle, with the hundreds digit (always one char) every 100 columns. */
export function rulerLabel(column: number): string {
  if (column <= 0) return " ";
  if (column % 100 === 0) return String((column / 100) % 10);
  return String(column % 10);
}

/**
 * The ruler over a COMPACTED column set: the rows render only the kept columns,
 * so the ruler does too — each label is the column's ORIGINAL 1-based number, glued
 * to the character it describes. (A blank-padded full-width ruler would drift one
 * position right of its character after the first dropped column.)
 */
export function rulerForColumns(keep: readonly number[]): string {
  return keep.map((c) => rulerLabel(c + 1)).join("");
}

/**
 * Map a pointer x offset (px, relative to the sequence text's left edge) to the
 * ORIGINAL 0-based column under it, or -1 when the offset is left of the text or
 * past the last kept column. The single home of the grid's hit-test arithmetic —
 * a block-level probe measuring the container instead of one character is exactly
 * the bug this keeps testable.
 */
export function columnAtOffset(x: number, charWidth: number, keep: readonly number[]): number {
  if (x < 0 || charWidth <= 0 || keep.length === 0) return -1;
  const index = Math.floor(x / charWidth);
  return keep[index] ?? -1;
}

/** Deterministic identity → color scale (red = conserved → gray = variable). */
export function conservationBandColor(identity: number, gapFraction: number): string {
  if (gapFraction >= 0.5) return "#8b8f96"; // gap-heavy column: neutral
  const v = Math.max(0, Math.min(1, identity));
  if (v >= 0.99) return "#c92a2a";
  if (v >= 0.9) return "#e8590c";
  if (v >= 0.8) return "#f59f00";
  if (v >= 0.7) return "#facc15";
  if (v >= 0.5) return "#94a3b8";
  return "#cbd5e1";
}

/**
 * The grid degrades to plain text on a COST model, not a cell count alone:
 * rows are virtualized (only the visible window renders; same-class characters
 * are grouped into runs, so a real row is tens of spans, not one per cell), so
 * a big-but-narrow alignment like a ColabFold a3m (14 633 × 427 = 6.25M cells,
 * measured: ~400 ms of one-time column statistics, ~2 ms for 30 visible rows)
 * is a perfectly good grid. What does hurt:
 *   - very many COLUMNS: per-row DOM/width cost, and the widest real
 *     alignments are two orders of magnitude below this cap;
 *   - a huge total CELL count: the one-time statistics pass is O(rows × columns)
 *     and blocks the main thread.
 */
export const PLAIN_TEXT_COLUMN_LIMIT = 20_000;
export const PLAIN_TEXT_CELL_LIMIT = 20_000_000;

export interface PlainTextLimits {
  columns?: number;
  cells?: number;
}

/** True when the grid should auto-degrade to plain text (spec scale guard). */
export function shouldUsePlainText(
  rowCount: number,
  columns: number,
  limits: PlainTextLimits = {},
): boolean {
  if (rowCount <= 0 || columns <= 0) return false;
  const columnLimit = limits.columns ?? PLAIN_TEXT_COLUMN_LIMIT;
  const cellLimit = limits.cells ?? PLAIN_TEXT_CELL_LIMIT;
  return columns > columnLimit || rowCount * columns > cellLimit;
}

export function filterRowsByQuery(sequences: MsaSequence[], query: string): MsaSequence[] {
  const q = query.trim().toLowerCase();
  if (q === "") return sequences;
  return sequences.filter((s) => s.name.toLowerCase().includes(q));
}

export interface ColumnFilter {
  conservedOnly?: boolean;
  hideGaps?: boolean;
}

/** The ORIGINAL 0-based column indices that survive the filters, in order. */
export function columnsToKeep(
  columns: number,
  seqs: MsaSequence[],
  stats: ColumnStat[],
  filter: ColumnFilter,
  conservedOpts?: ConservedOptions,
): number[] {
  const keep: number[] = [];
  for (let c = 0; c < columns; c++) {
    const st = stats[c];
    if (filter.conservedOnly && (st === undefined || !isConservedCol(st, conservedOpts))) continue;
    if (filter.hideGaps && seqs.length > 0 && seqs.every((s) => s.seq[c] === "-")) continue;
    keep.push(c);
  }
  return keep;
}
