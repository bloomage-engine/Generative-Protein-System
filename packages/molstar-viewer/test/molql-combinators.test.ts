import { test } from "node:test";
import assert from "node:assert/strict";
import { MolqlError, compileMolql } from "../src/molql.js";
import { atomCount, loadStructure, pdb, residue } from "./structure-fixture.js";

async function structure() {
  return loadStructure(
    pdb([residue("LYS", "A", 1, 0), residue("ALA", "A", 2, 3.5), residue("ALA", "A", 3, 30)]),
  );
}

test("sel.atom.intersect compiles and selects the shared atom sets", async () => {
  const loci = compileMolql(
    `(sel.atom.intersect
       (sel.atom.res (in-range atom.resno 1 2))
       (sel.atom.res (= atom.entity-type polymer)))`,
    await structure(),
  );
  assert.equal(atomCount(loci), 4);
});

test("dist-cluster keeps only pairs inside the min/max window", async () => {
  const loci = compileMolql(
    `(sel.atom.dist-cluster
       :matrix [[0 5] [2 0]]
       :selections [
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname ALA))])`,
    await structure(),
  );
  assert.equal(atomCount(loci), 4);
});

test("dist-cluster rejects pairs closer than the minimum distance", async () => {
  const loci = compileMolql(
    `(sel.atom.dist-cluster
       :matrix [[0 5] [3 0]]
       :selections [
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname ALA))])`,
    await structure(),
  );
  assert.equal(atomCount(loci), 0);
});

test("dist-cluster returns only mutually close, distinct sets for three selections", async () => {
  const loci = compileMolql(
    `(sel.atom.dist-cluster
       :matrix [[0 5 5] [0 0 5] [0 0 0]]
       :selections [
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname LYS))])`,
    await loadStructure(
      pdb([
        residue("LYS", "A", 1, 0),
        residue("LYS", "A", 2, 2),
        residue("LYS", "A", 3, 4),
        residue("LYS", "A", 4, 40),
      ]),
    ),
  );
  assert.equal(atomCount(loci), 6);
});

test("dist-cluster never reuses one atom set for two selections", async () => {
  const loci = compileMolql(
    `(sel.atom.dist-cluster
       :matrix [[0 5] [0 0]]
       :selections [
         (sel.atom.res (= atom.resname LYS))
         (sel.atom.res (= atom.resname LYS))])`,
    await structure(),
  );
  assert.equal(atomCount(loci), 0);
});

test("dist-cluster rejects a matrix that does not match the selection count", async () => {
  const target = await structure();
  assert.throws(
    () =>
      compileMolql(
        `(sel.atom.dist-cluster
           :matrix [[0 5]]
           :selections [
             (sel.atom.res (= atom.resname LYS))
             (sel.atom.res (= atom.resname ALA))])`,
        target,
      ),
    (error: unknown) =>
      error instanceof MolqlError && error.code === "COMPILE" && /matrix/.test(error.message),
  );
});
