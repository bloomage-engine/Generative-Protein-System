import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAtomMolql,
  formatBondMolql,
  formatInteractionMolql,
  formatResidueMolql,
  formatStructureMention,
  molqlTargetKey,
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

test("an atom is a single-atom expression", () => {
  assert.equal(
    formatAtomMolql({ chain: "A", resno: 42, resname: "ALA", atomName: "CA" }),
    "(sel.atom.atoms (and (= atom.chain A) (= atom.resno 42) (= atom.resname ALA) (= atom.name CA)))",
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

test("an interaction reuses the endpoint-union form", () => {
  const a = { chain: "A", resno: 42, resname: "SER", atomName: "OG" };
  const b = { chain: "A", resno: 88, resname: "ASP", atomName: "OD1" };
  assert.equal(formatInteractionMolql(a, b), formatBondMolql(a, b));
});

test("a structure mention carries the project, path and expression", () => {
  assert.equal(
    formatStructureMention("project-default", "boltz_holo.pdb", "(sel.atom.all)"),
    "@project-default/boltz_holo.pdb/(sel.atom.all)",
  );
});

test("a structure mention without a project falls back to the bare path", () => {
  assert.equal(
    formatStructureMention(null, "boltz_holo.pdb", "(sel.atom.all)"),
    "@boltz_holo.pdb/(sel.atom.all)",
  );
});

test("a mention label is appended as a # suffix", () => {
  assert.equal(
    formatStructureMention("project-default", "boltz_holo.pdb", "(sel.atom.all)", "Hydrogen Bond"),
    "@project-default/boltz_holo.pdb/(sel.atom.all) #Hydrogen Bond",
  );
});

test("target keys distinguish residues and either bond endpoint", () => {
  assert.equal(
    molqlTargetKey({ kind: "residue", residue: { chain: "A", resno: 42, resname: "ALA" } }),
    "residue:A:42:ALA",
  );
  const bond = {
    kind: "bond" as const,
    a: { chain: "A", resno: 93, resname: "CYS", atomName: "N" },
    b: { chain: "A", resno: 89, resname: "ILE", atomName: "O" },
  };
  assert.equal(molqlTargetKey(bond), "bond:A:93:CYS:N:A:89:ILE:O");
  assert.notEqual(
    molqlTargetKey(bond),
    molqlTargetKey({ ...bond, b: { chain: "A", resno: 90, resname: "ILE", atomName: "O" } }),
  );
});

test("target keys distinguish an atom and carry the interaction type", () => {
  assert.equal(
    molqlTargetKey({ kind: "atom", atom: { chain: "A", resno: 42, resname: "ALA", atomName: "CA" } }),
    "atom:A:42:ALA:CA",
  );
  assert.equal(
    molqlTargetKey({
      kind: "interaction",
      a: { chain: "A", resno: 42, resname: "SER", atomName: "OG" },
      b: { chain: "A", resno: 88, resname: "ASP", atomName: "OD1" },
      interactionType: "Hydrogen Bond",
    }),
    "interaction:Hydrogen Bond:A:42:SER:OG:A:88:ASP:OD1",
  );
});
