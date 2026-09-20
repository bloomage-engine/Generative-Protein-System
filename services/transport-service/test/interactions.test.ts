import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeInteractionsForSelection,
  MolqlCompileError,
  UnsupportedStructureFormatError,
} from "../src/interactions.js";

/** One water molecule — enough to exercise parse → compile → compute → render. */
const WATER_PDB = [
  "HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O",
  "HETATM    2  H1  HOH A   1       0.957   0.000   0.000  1.00  0.00           H",
  "HETATM    3  H2  HOH A   1      -0.240   0.927   0.000  1.00  0.00           H",
  "END",
  "",
].join("\n");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("rejects a file name that is not a structure format", async () => {
  await assert.rejects(
    computeInteractionsForSelection({ fileName: "notes.txt", data: bytes(""), molql: "(sel.atom.all)" }),
    UnsupportedStructureFormatError,
  );
});

test("rejects an invalid MolQL expression against a parsed structure", async () => {
  await assert.rejects(
    computeInteractionsForSelection({
      fileName: "water.pdb",
      data: bytes(WATER_PDB),
      molql: "(sel.atom.",
    }),
    MolqlCompileError,
  );
});

test("a valid selection returns a well-formed (possibly empty) table", async () => {
  const result = await computeInteractionsForSelection({
    fileName: "water.pdb",
    data: bytes(WATER_PDB),
    molql: "(sel.atom.all)",
  });
  assert.equal(result.target, "(sel.atom.all)");
  assert.ok(Array.isArray(result.rows));
  assert.equal(result.truncated, false);
  assert.match(result.table, /\| Interaction \| From \| To \| Distance \(Å\) \|/);
});
