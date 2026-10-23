import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileLoci,
  loadMolstar,
  lociSize,
  parseStructure,
  MolqlCompileError,
} from "../src/structure.js";

const PDB = [
  "ATOM      1  N   LYS A   1       0.000   0.000   0.000  1.00  0.00           N",
  "ATOM      2  CA  LYS A   1       1.000   0.000   0.000  1.00  0.00           C",
  "ATOM      3  N   ALA A   2       3.500   0.000   0.000  1.00  0.00           N",
  "ATOM      4  CA  ALA A   2       4.500   0.000   0.000  1.00  0.00           C",
  "ATOM      5  N   ALA A   3      30.000   0.000   0.000  1.00  0.00           N",
  "ATOM      6  CA  ALA A   3      31.000   0.000   0.000  1.00  0.00           C",
  "END",
  "",
].join("\n");

async function structure() {
  const m = loadMolstar();
  return { m, structure: await parseStructure(m, "pdb", new TextEncoder().encode(PDB)) };
}

test("the service compiles sel.atom.intersect", async () => {
  const { m, structure: s } = await structure();
  const loci = compileLoci(
    m,
    s,
    `(sel.atom.intersect
       (sel.atom.res (in-range atom.resno 1 2))
       (sel.atom.res (= atom.entity-type polymer)))`,
  );
  assert.equal(lociSize(m, loci), 4);
});

test("the service compiles sel.atom.dist-cluster", async () => {
  const { m, structure: s } = await structure();
  const loci = compileLoci(
    m,
    s,
    `(sel.atom.dist-cluster
       :matrix [[0 5] [2 0]]
       :selections [
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname ALA))])`,
  );
  assert.equal(lociSize(m, loci), 4);
});

test("the service rejects a mismatched dist-cluster matrix", async () => {
  const { m, structure: s } = await structure();
  assert.throws(
    () =>
      compileLoci(
        m,
        s,
        `(sel.atom.dist-cluster
           :matrix [[0 5]]
           :selections [
             (sel.atom.res (= atom.resname LYS))
             (sel.atom.res (= atom.resname ALA))])`,
      ),
    (error: unknown) =>
      error instanceof MolqlCompileError && /matrix/.test(error.message),
  );
});
