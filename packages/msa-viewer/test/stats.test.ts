import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONSERVED,
  columnStats,
  isConservedCol,
  sequenceStats,
  tableStats,
} from "../src/stats.js";
import type { MsaAligned } from "../src/formats.js";

const ALIGNED: MsaAligned = {
  kind: "aligned",
  sequences: [
    { name: "a", seq: "MK--" },
    { name: "b", seq: "MK-M" },
    { name: "c", seq: "MKMM" },
  ],
  columns: 4,
  annotations: [],
};

test("columnStats: identity = share of the most frequent non-gap char; gapFraction = share of gaps", () => {
  const stats = columnStats(ALIGNED);
  assert.equal(stats.length, 4);
  assert.equal(stats[0]!.identity, 1);   // col 1: M,M,M
  assert.equal(stats[0]!.gapFraction, 0);
  assert.equal(stats[1]!.identity, 1);   // col 2: K,K,K
  assert.equal(stats[1]!.gapFraction, 0);
  assert.equal(stats[2]!.identity, 1 / 3); // col 3: -,-,M
  assert.equal(stats[2]!.gapFraction, 2 / 3);
  assert.equal(stats[3]!.gapFraction, 1 / 3); // col 4: -,M,M
  assert.equal(stats[3]!.identity, 2 / 3);
});

test("isConservedCol: defaults and overrides", () => {
  assert.equal(isConservedCol(stats0()), true);
  assert.equal(isConservedCol({ column: 3, identity: 1 / 3, gapFraction: 2 / 3 }), false);
  assert.equal(
    isConservedCol({ column: 2, identity: 1 / 3, gapFraction: 0 }, { minIdentity: 0.2, maxGapFraction: 1 }),
    true,
  );
});

function stats0() {
  return columnStats(ALIGNED)[0]!;
}

test("sequenceStats: length + gapFraction per sequence", () => {
  const ss = sequenceStats(ALIGNED);
  assert.deepEqual(ss, [
    { name: "a", length: 4, gapFraction: 0.5 }, // "MK--"
    { name: "b", length: 4, gapFraction: 0.25 }, // "MK-M"
    { name: "c", length: 4, gapFraction: 0 }, // "MKMM"
  ]);
});

test("stats are total over every MsaParseResult shape", () => {
  const mmseqs = { kind: "mmseqs" as const, fields: ["query", "target"], rows: [[ "a", "b" ]] };
  assert.deepEqual(columnStats(mmseqs), []);
  assert.deepEqual(sequenceStats(mmseqs), []);
  const t0 = tableStats(mmseqs);
  assert.equal(t0.sequences, 0);
  const unaligned = { kind: "unaligned" as const, sequences: [{ name: "x", seq: "ABC" }] };
  assert.deepEqual(sequenceStats(unaligned)[0], { name: "x", length: 3, gapFraction: 0 });
});

test("tableStats reuses caller-computed column stats (the grid passes its memo, halving the work)", () => {
  const stats = columnStats(ALIGNED);
  assert.deepEqual(tableStats(ALIGNED, undefined, stats), tableStats(ALIGNED));
});

test("tableStats: averages + conserved count use the same predicate", () => {
  const t = tableStats(ALIGNED);
  assert.equal(t.sequences, 3);
  assert.equal(t.columns, 4);
  assert.equal(t.averageIdentity, (1 + 1 + 1 / 3 + 2 / 3) / 4); // = 0.75
  assert.equal(t.conservedColumns, 2); // cols 1 and 2 (identity 1.0, gaps 0)
  assert.deepEqual(DEFAULT_CONSERVED, { minIdentity: 0.9, maxGapFraction: 0.1 });
});
