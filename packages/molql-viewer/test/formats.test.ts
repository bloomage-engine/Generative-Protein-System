import { test } from "node:test";
import assert from "node:assert/strict";
import { isStructureFile, structureFormat } from "../src/formats.js";

test("maps text structure extensions", () => {
  assert.deepEqual(structureFormat("1abc.pdb"), { format: "pdb", isBinary: false });
  assert.deepEqual(structureFormat("1abc.cif"), { format: "mmcif", isBinary: false });
  assert.deepEqual(structureFormat("1abc.mmcif"), { format: "mmcif", isBinary: false });
  assert.deepEqual(structureFormat("ligand.mol2"), { format: "mol2", isBinary: false });
  assert.deepEqual(structureFormat("ligand.sdf"), { format: "sdf", isBinary: false });
  assert.deepEqual(structureFormat("frame.xyz"), { format: "xyz", isBinary: false });
  assert.deepEqual(structureFormat("traj.gro"), { format: "gro", isBinary: false });
});

test("bcif is mmcif + binary", () => {
  assert.deepEqual(structureFormat("1abc.bcif"), { format: "mmcif", isBinary: true });
});

test("is case-insensitive and tolerates .gz", () => {
  assert.deepEqual(structureFormat("1ABC.PDB"), { format: "pdb", isBinary: false });
  assert.deepEqual(structureFormat("1abc.pdb.gz"), { format: "pdb", isBinary: false });
  assert.deepEqual(structureFormat("1abc.cif.gz"), { format: "mmcif", isBinary: false });
  assert.deepEqual(structureFormat("1abc.bcif.gz"), { format: "mmcif", isBinary: true });
});

test("non-structure names are not structure files", () => {
  assert.equal(structureFormat("notes.txt"), null);
  assert.equal(structureFormat("protein.fasta"), null);
  assert.equal(structureFormat("noext"), null);
  assert.equal(isStructureFile("trajectory.dcd"), false);
  assert.equal(isStructureFile("4hhb.pdb"), true);
});
