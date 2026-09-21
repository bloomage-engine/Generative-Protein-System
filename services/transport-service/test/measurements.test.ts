import { test } from "node:test";
import assert from "node:assert/strict";
import { MolqlCompileError, UnsupportedStructureFormatError } from "../src/structure.js";
import { computeMeasurements, MeasurementError } from "../src/measurements.js";

/** One water molecule — enough to exercise parse → compile → compute. */
const WATER_PDB = [
  "HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O",
  "HETATM    2  H1  HOH A   1       0.957   0.000   0.000  1.00  0.00           H",
  "HETATM    3  H2  HOH A   1      -0.240   0.927   0.000  1.00  0.00           H",
  "END",
  "",
].join("\n");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const O = "(sel.atom.atoms (= atom.name O))";
const H1 = "(sel.atom.atoms (= atom.name H1))";
const H2 = "(sel.atom.atoms (= atom.name H2))";

const compute = (kind: string, selections: string[]) =>
  computeMeasurements({ fileName: "water.pdb", data: bytes(WATER_PDB), kind, selections });

test("rejects a file name that is not a structure format", async () => {
  await assert.rejects(
    computeMeasurements({
      fileName: "notes.txt",
      data: bytes(""),
      kind: "distance",
      selections: [O, H1],
    }),
    UnsupportedStructureFormatError,
  );
});

test("rejects an unknown kind and a wrong selection count", async () => {
  await assert.rejects(compute("volume", [O]), MeasurementError);
  await assert.rejects(compute("distance", [O]), MeasurementError);
  await assert.rejects(compute("angle", [O, H1]), MeasurementError);
  await assert.rejects(compute("dihedral", [O, H1, H2]), MeasurementError);
});

test("rejects a selection that matches no atoms", async () => {
  await assert.rejects(compute("distance", [O, "(sel.atom.atoms (= atom.name ZZ))"]), MeasurementError);
});

test("rejects an invalid MolQL expression against a parsed structure", async () => {
  await assert.rejects(compute("distance", ["(sel.atom.", H1]), MolqlCompileError);
});

test("distance returns the O–H1 bond length", async () => {
  const result = await compute("distance", [O, H1]);
  assert.equal(result.kind, "distance");
  const distance = result.values.distance as number;
  assert.ok(Math.abs(distance - 0.957) < 0.01, `expected ~0.957, got ${distance}`);
  assert.match(result.text, /Distance: 0\.96 Å/);
  assert.match(result.text, /A: A\/HOH 1:O/);
});

test("angle and dihedral return degrees", async () => {
  const angle = await compute("angle", [O, H1, H2]);
  assert.equal(typeof angle.values.angle, "number");
  assert.match(angle.text, /Angle: \d+\.\d+° — A: A\/HOH 1:O/);

  const dihedral = await compute("dihedral", [O, H1, H2, O]);
  assert.equal(typeof dihedral.values.dihedral, "number");
  assert.match(dihedral.text, /Dihedral: /);
});

test("label and orientation/plane return their geometry", async () => {
  const label = await compute("label", [O]);
  assert.deepEqual(label.values.labels, ["A/HOH 1:O"]);

  const orientation = await compute("orientation", [O, H1, H2]);
  assert.equal((orientation.values.atoms as number), 3);
  assert.equal((orientation.values.origin as number[]).length, 3);
  assert.ok(typeof orientation.values.axes === "object");

  const plane = await compute("plane", [O, H1, H2]);
  assert.equal((plane.values.centroid as number[]).length, 3);
  assert.equal((plane.values.normal as number[]).length, 3);
});
