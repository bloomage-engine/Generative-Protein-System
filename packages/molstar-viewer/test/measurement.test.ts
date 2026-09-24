import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMeasurementKind,
  MOLQL_MEASUREMENTS_RESULT_TYPE,
  MOLQL_MEASUREMENTS_TOOL_NAME,
  parseMeasurementToolResult,
} from "../src/measurement.js";

test("tool name and result type are pinned", () => {
  assert.equal(MOLQL_MEASUREMENTS_TOOL_NAME, "measurements");
  assert.equal(MOLQL_MEASUREMENTS_RESULT_TYPE, "molql-measurements");
});

test("recognizes only the six measurement kinds", () => {
  for (const kind of ["label", "distance", "angle", "dihedral", "orientation", "plane"]) {
    assert.equal(isMeasurementKind(kind), true);
  }
  assert.equal(isMeasurementKind("volume"), false);
  assert.equal(isMeasurementKind(undefined), false);
});

test("parses the canonical tool JSON string, keeping selection order", () => {
  const raw = JSON.stringify({
    type: "molql-measurements",
    kind: "distance",
    project: "project-default",
    path: "boltz_holo.pdb",
    selections: ["(sel.atom.atoms (= atom.name N))", "(sel.atom.atoms (= atom.name O))"],
    values: { distance: 3.45 },
    text: "Distance: 3.45 Å",
  });
  assert.deepEqual(parseMeasurementToolResult(raw), {
    kind: "distance",
    selections: ["(sel.atom.atoms (= atom.name N))", "(sel.atom.atoms (= atom.name O))"],
  });
});

test("parses an already-decoded object and drops unknown fields", () => {
  assert.deepEqual(
    parseMeasurementToolResult({
      type: "molql-measurements",
      kind: "angle",
      selections: ["a", "b", "c"],
      values: { angle: 120 },
      extra: 1,
    }),
    { kind: "angle", selections: ["a", "b", "c"] },
  );
});

test("unwraps a nested result object and trims expressions", () => {
  assert.deepEqual(
    parseMeasurementToolResult({
      result: { kind: "dihedral", selections: [" (a) ", "(b)", "(c)", "(d)"] },
    }),
    { kind: "dihedral", selections: ["(a)", "(b)", "(c)", "(d)"] },
  );
});

test("extracts JSON embedded in prose", () => {
  const text = 'Measured:\n{"kind":"label","selections":["(sel.atom.res atom.is-modified)"]}\nDone.';
  assert.deepEqual(parseMeasurementToolResult(text), {
    kind: "label",
    selections: ["(sel.atom.res atom.is-modified)"],
  });
});

test("rejects unusable payloads", () => {
  assert.equal(parseMeasurementToolResult(""), null);
  assert.equal(parseMeasurementToolResult("no json here"), null);
  assert.equal(parseMeasurementToolResult(null), null);
  assert.equal(parseMeasurementToolResult({ kind: "distance" }), null);
  assert.equal(parseMeasurementToolResult({ kind: "volume", selections: ["(a)"] }), null);
  assert.equal(parseMeasurementToolResult({ kind: "distance", selections: [] }), null);
  assert.equal(parseMeasurementToolResult({ kind: "distance", selections: ["   "] }), null);
  assert.equal(parseMeasurementToolResult({ kind: "distance", selections: [42] }), null);
});
