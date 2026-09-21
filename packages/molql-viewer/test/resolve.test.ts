import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePDB } from "molstar/lib/mol-io/reader/pdb/parser.js";
import { trajectoryFromPDB } from "molstar/lib/mol-model-formats/structure/pdb.js";
import { Bond, Structure, StructureElement } from "molstar/lib/mol-model/structure.js";
import { OrderedSet } from "molstar/lib/mol-data/int.js";
import { describeMolqlTarget } from "../src/resolve.js";

const PDB = [
  "ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00           N",
  "ATOM      2  CA  ALA A   1       1.458   0.000   0.000  1.00  0.00           C",
  "ATOM      3  C   ALA A   1       2.009   1.420   0.000  1.00  0.00           C",
  "ATOM      4  O   ALA A   1       1.251   2.390   0.000  1.00  0.00           O",
  "ATOM      5  CB  ALA A   1       1.988  -0.773  -1.199  1.00  0.00           C",
  "END",
].join("\n");

async function loadStructure() {
  const parsed = await parsePDB(PDB).run();
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  return Structure.ofModel(trajectory.frames[0]);
}

test("the element picking level yields a single atom", async () => {
  const structure = await loadStructure();
  const unit = structure.units[0];
  const loci = StructureElement.Loci(structure, [
    { unit, indices: OrderedSet.ofRange(0, unit.elements.length) },
  ]);
  const target = describeMolqlTarget(loci, "element");
  assert.equal(target?.kind, "atom");
  assert.equal(target?.kind === "atom" ? target.atom.atomName : "", "N");
  assert.equal(target?.kind === "atom" ? target.atom.resname : "", "ALA");
});

test("the residue picking level yields a residue", async () => {
  const structure = await loadStructure();
  const unit = structure.units[0];
  const loci = StructureElement.Loci(structure, [
    { unit, indices: OrderedSet.ofRange(0, unit.elements.length) },
  ]);
  const target = describeMolqlTarget(loci, "residue");
  assert.equal(target?.kind, "residue");
  assert.equal(target?.kind === "residue" ? target.residue.resno : -1, 1);
});

test("a covalent bond yields its two endpoint atoms", async () => {
  const structure = await loadStructure();
  const unit = structure.units[0];
  const bond = Bond.Location(structure, unit, unit.bonds.a[0], structure, unit, unit.bonds.b[0]);
  const target = describeMolqlTarget(Bond.Loci(structure, [bond]), "residue");
  assert.equal(target?.kind, "bond");
  if (target?.kind === "bond") {
    assert.equal(target.a.chain, "A");
    assert.equal(target.b.chain, "A");
  }
});

test("a dashed interaction yields its two representative endpoint atoms", async () => {
  const structure = await loadStructure();
  const unit = structure.units[0];
  const features = { members: [0, 1], offsets: [0, 1, 2] };
  const unitsFeatures = new Map([[unit.id, features]]);
  // A structurally-valid Interactions.Loci; `locationLabel` falls back to a
  // generic name because the contact graphs are absent.
  const loci = {
    kind: "data-loci",
    tag: "interactions",
    data: { structure, interactions: { unitsFeatures, unitsContacts: new Map(), contacts: {} } },
    elements: [{ unitA: unit, indexA: 0, unitB: unit, indexB: 1 }],
    getBoundingSphere: () => undefined,
    getLabel: () => "",
  };
  const target = describeMolqlTarget(loci, "residue");
  assert.equal(target?.kind, "interaction");
  if (target?.kind === "interaction") {
    assert.equal(target.a.atomName, "N");
    assert.equal(target.b.atomName, "CA");
    assert.equal(target.interactionType, "Interaction");
  }
});
