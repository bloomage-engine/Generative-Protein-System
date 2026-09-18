import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBondMolql,
  formatResidueMolql,
  formatStructureMention,
} from "../src/selection.js";

test("a residue becomes a grouped atom.chain/resno/resname expression", () => {
  assert.equal(
    formatResidueMolql({ chain: "A", resno: 42, resname: "ALA" }),
    "(sel.atom.res (and (= atom.chain A) (= atom.resno 42) (= atom.resname ALA)))",
  );
});

test("a residue with resno 0 (a ligand) still renders", () => {
  assert.equal(
    formatResidueMolql({ chain: "B", resno: 0, resname: "LIG" }),
    "(sel.atom.res (and (= atom.chain B) (= atom.resno 0) (= atom.resname LIG)))",
  );
});

test("a negative resno is not quoted", () => {
  assert.equal(
    formatResidueMolql({ chain: "A", resno: -1, resname: "GLY" }),
    "(sel.atom.res (and (= atom.chain A) (= atom.resno -1) (= atom.resname GLY)))",
  );
});

test("a value with spaces falls back to the backtick literal form", () => {
  assert.equal(
    formatResidueMolql({ chain: "A B", resno: 7, resname: "ALA" }),
    "(sel.atom.res (and (= atom.chain `A B`) (= atom.resno 7) (= atom.resname ALA)))",
  );
});

test("a bond is the union of its two endpoint atoms", () => {
  assert.equal(
    formatBondMolql(
      { chain: "A", resno: 93, resname: "CYS", atomName: "N" },
      { chain: "A", resno: 89, resname: "ILE", atomName: "O" },
    ),
    "(sel.atom.atoms (or (and (= atom.chain A) (= atom.resno 93) (= atom.resname CYS) (= atom.name N)) (and (= atom.chain A) (= atom.resno 89) (= atom.resname ILE) (= atom.name O))))",
  );
});

test("a structure mention pairs the workspace path with the expression", () => {
  assert.equal(
    formatStructureMention("boltz_holo.pdb", "(sel.atom.all)"),
    "@boltz_holo.pdb/(sel.atom.all)",
  );
});
