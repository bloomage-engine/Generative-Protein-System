import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAIN_TEXT_CELL_LIMIT,
  columnsToKeep,
  conservationBandColor,
  filterRowsByQuery,
  groupSpans,
  rowWindow,
  rulerLabel,
  rulerLine,
  shouldUsePlainText,
} from "../src/grid.js";

test("rowWindow: overscan, clamping, and scroll position", () => {
  assert.deepEqual(rowWindow(100, 0, 400, 20, 4), { start: 0, count: 28 });
  assert.deepEqual(rowWindow(100, 1000, 400, 20, 4), { start: 46, count: 28 });
  assert.deepEqual(rowWindow(5, 1000, 400, 20, 4), { start: 5, count: 0 }); // past the end
  assert.deepEqual(rowWindow(0, 0, 400, 20), { start: 0, count: 0 });
  assert.deepEqual(rowWindow(10, 0, 40, 20, 4), { start: 0, count: 10 }); // clamped to total
});

test("groupSpans merges consecutive same-class runs, minimum run 1", () => {
  const text = "aabaa";
  const spans = groupSpans(text, (i) => (text.charAt(i) === "b" ? "Y" : "X"));
  assert.deepEqual(spans, [
    { text: "aa", cls: "X" },
    { text: "b", cls: "Y" },
    { text: "aa", cls: "X" },
  ]);
  assert.deepEqual(groupSpans("", () => "X"), []);
});

test("ruler: the 1..9/0 cycle with the hundreds digit every 100", () => {
  assert.equal(rulerLabel(1), "1");
  assert.equal(rulerLabel(9), "9");
  assert.equal(rulerLabel(10), "0");
  assert.equal(rulerLabel(15), "5");
  assert.equal(rulerLabel(100), "1");
  assert.equal(rulerLabel(200), "2");
  assert.equal(rulerLine(12), "123456789012");
});

test("rulerLine blanks the dropped (filtered-out) columns but keeps their width", () => {
  const keep = new Set([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]); // the 4th column (1-based) dropped
  assert.equal(rulerLine(12, keep), "123\u00A056789012");
});

test("conservationBandColor: identity scale, gap-heavy override, clamped input", () => {
  assert.equal(conservationBandColor(1, 0), "#c92a2a");
  assert.equal(conservationBandColor(0.95, 0), "#e8590c");
  assert.equal(conservationBandColor(0.75, 0.2), "#facc15");
  assert.equal(conservationBandColor(0.85, 0.2), "#f59f00");
  assert.equal(conservationBandColor(0.75, 0.8), "#8b8f96"); // gap-heavy wins
  assert.equal(conservationBandColor(0.1, 0), "#cbd5e1");
  assert.equal(conservationBandColor(1.7, -1), "#c92a2a");   // inputs are clamped
});

test("shouldUsePlainText: the 250k-cell guard (and a custom limit)", () => {
  assert.equal(PLAIN_TEXT_CELL_LIMIT, 250_000);
  assert.equal(shouldUsePlainText(1000, 300), true);      // 300k > 250k
  assert.equal(shouldUsePlainText(100, 1000), false);     // 100k
  assert.equal(shouldUsePlainText(250, 1000), false);     // exactly 250k is still fine
  assert.equal(shouldUsePlainText(10, 11, 100), true);    // 110 > 100
  assert.equal(shouldUsePlainText(10, 10, 100), false);   // exactly 100 is still fine
  assert.equal(shouldUsePlainText(0, 5), false);          // degenerate input
});

test("filterRowsByQuery: case-insensitive name substring; empty query is identity", () => {
  const seqs = [
    { name: "Seq1", seq: "ABC" },
    { name: "myseq2", seq: "DEF" },
  ];
  assert.equal(filterRowsByQuery(seqs, ""), seqs);
  assert.deepEqual(filterRowsByQuery(seqs, "SEQ").map((s) => s.name), ["Seq1", "myseq2"]);
  assert.deepEqual(filterRowsByQuery(seqs, "  seq2  ").map((s) => s.name), ["myseq2"]);
});

test("columnsToKeep: conserved-only and hide-gaps, over the ORIGINAL columns", () => {
  const seqs = [
    { name: "a", seq: "A--B" },
    { name: "b", seq: "CD--" },
  ];
  // col1 (A,C): identity .5, gap 0 · col2 (-,D): identity .5, gap .5
  // col3 (-,-): identity 0,  gap 1 · col4 (B,-): identity .5, gap .5
  const stats = [
    { column: 1, identity: 0.5, gapFraction: 0 },
    { column: 2, identity: 0.5, gapFraction: 0.5 },
    { column: 3, identity: 0, gapFraction: 1 },
    { column: 4, identity: 0.5, gapFraction: 0.5 },
  ];
  // hideGaps drops only the ALL-gap column (1-based col 3)
  assert.deepEqual(columnsToKeep(4, seqs, stats, { hideGaps: true }), [0, 1, 3]);
  // conservedOnly keeps exactly the columns that pass the (parameterized) predicate
  assert.deepEqual(
    columnsToKeep(4, seqs, stats, { conservedOnly: true }, { minIdentity: 0.5, maxGapFraction: 0.5 }),
    [0, 1, 3],
  );
  // a stricter gap predicate drops the half-gap columns too
  assert.deepEqual(
    columnsToKeep(4, seqs, stats, { conservedOnly: true }, { minIdentity: 0.5, maxGapFraction: 0.4 }),
    [0],
  );
  // no filter keeps everything
  assert.deepEqual(columnsToKeep(4, seqs, stats, {}), [0, 1, 2, 3]);
});
