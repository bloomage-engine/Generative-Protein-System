import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePDB } from "molstar/lib/mol-io/reader/pdb/parser.js";
import { trajectoryFromPDB } from "molstar/lib/mol-model-formats/structure/pdb.js";
import { Bond, Structure, StructureElement, Unit } from "molstar/lib/mol-model/structure.js";
import { DataLoci } from "molstar/lib/mol-model/loci.js";
import { describeMolqlTarget } from "../src/resolve.js";

const PDB = [
  "ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00           N",
  "ATOM      2  CA  ALA A   1       1.458   0.000   0.000  1.00  0.00           C",
  "ATOM      3  C   ALA A   1       2.009   1.420   0.000  1.00  0.00           C",
  "ATOM      4  O   ALA A   1       1.251   2.390   0.000  1.00  0.00           O",
  "ATOM      5  CB  ALA A   1       1.988  -0.773  -1.199  1.00  0.00           C",
  "END",
].join("\n");

async function loadStructure(): Promise<Structure> {
  const parsed = await parsePDB(PDB).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  return Structure.ofModel(trajectory.representative);
}

/** The fixture holds a single atomic unit. */
function firstUnit(structure: Structure): Unit.Atomic {
  const unit = structure.units[0];
  if (!unit || !Unit.isAtomic(unit)) throw new Error("expected a single atomic unit in the fixture");
  return unit;
}

test("the element picking level yields a single atom", async () => {
  const structure = await loadStructure();
  const loci = StructureElement.Loci.all(structure);
  const target = describeMolqlTarget(loci, "element");
  assert.equal(target?.kind, "atom");
  assert.equal(target?.kind === "atom" ? target.atom.atomName : "", "N");
  assert.equal(target?.kind === "atom" ? target.atom.resname : "", "ALA");
});

test("the residue picking level yields a residue", async () => {
  const structure = await loadStructure();
  const loci = StructureElement.Loci.all(structure);
  const target = describeMolqlTarget(loci, "residue");
  assert.equal(target?.kind, "residue");
  assert.equal(target?.kind === "residue" ? target.residue.resno : -1, 1);
});

test("a covalent bond yields its two endpoint atoms", async () => {
  const structure = await loadStructure();
  const unit = firstUnit(structure);
  const aIndex = unit.bonds.a[0] as StructureElement.UnitIndex;
  const bIndex = unit.bonds.b[0] as StructureElement.UnitIndex;
  const bond = Bond.Location(structure, unit, aIndex, structure, unit, bIndex);
  const target = describeMolqlTarget(Bond.Loci(structure, [bond]), "residue");
  assert.equal(target?.kind, "bond");
  if (target?.kind === "bond") {
    assert.equal(target.a.chain, "A");
    assert.equal(target.b.chain, "A");
  }
});

test("a dashed interaction yields its two representative endpoint atoms", async () => {
  const structure = await loadStructure();
  const unit = firstUnit(structure);
  const features = { members: [0, 1], offsets: [0, 1, 2] };
  const data = {
    structure,
    interactions: {
      unitsFeatures: new Map<number, typeof features>([[unit.id, features]]),
      unitsContacts: new Map<number, never>(),
      contacts: {},
    },
  };
  // A DataLoci recognized as an interaction by its "interactions" tag; `locationLabel`
  // falls back to a generic name because the contact graphs are absent.
  const element = { unitA: unit, indexA: 0, unitB: unit, indexB: 1 };
  const loci = DataLoci("interactions", data, [element], undefined, () => "");
  const target = describeMolqlTarget(loci, "residue");
  assert.equal(target?.kind, "interaction");
  if (target?.kind === "interaction") {
    assert.equal(target.a.atomName, "N");
    assert.equal(target.b.atomName, "CA");
    assert.equal(target.interactionType, "Interaction");
  }
});
