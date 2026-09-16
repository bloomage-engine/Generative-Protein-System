import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MolqlError,
  MOLQL_TOOL_NAME,
  MOLQL_TOOL_RESULT_TYPE,
  parseMolqlToolResult,
} from "../src/directive.js";

test("tool name and result type are pinned", () => {
  assert.equal(MOLQL_TOOL_NAME, "molql");
  assert.equal(MOLQL_TOOL_RESULT_TYPE, "molql-selection");
});

test("MolqlError carries a code the bridge can branch on", () => {
  const expected = new MolqlError("No structure viewer is open.", "NO_VIEWER");
  assert.equal(expected.name, "MolqlError");
  assert.equal(expected.code, "NO_VIEWER");
  assert.ok(expected instanceof MolqlError);
  assert.equal(new MolqlError("bad expression").code, "COMPILE");
});

test("parses the canonical tool JSON string", () => {
  const raw = JSON.stringify({
    type: "molql-selection",
    molql: "(sel.atom.chains (= atom.chain A))",
    description: "chain A",
    focus: true,
    mode: "select",
  });
  assert.deepEqual(parseMolqlToolResult(raw), {
    molql: "(sel.atom.chains (= atom.chain A))",
    description: "chain A",
    focus: true,
    mode: "select",
  });
});

test("parses an already-decoded object and keeps only known fields", () => {
  assert.deepEqual(
    parseMolqlToolResult({ type: "molql-selection", molql: "(sel.atom.all)", extra: 1 }),
    { molql: "(sel.atom.all)" },
  );
});

test("unwraps a nested result object", () => {
  assert.deepEqual(
    parseMolqlToolResult({ result: { molql: "(sel.atom.all)" } }),
    { molql: "(sel.atom.all)" },
  );
});

test("extracts JSON embedded in prose / a fenced block", () => {
  const text = 'Here you go:\n```json\n{"molql":"(sel.atom.res atom.is-modified)","mode":"highlight"}\n```';
  assert.deepEqual(parseMolqlToolResult(text), {
    molql: "(sel.atom.res atom.is-modified)",
    mode: "highlight",
  });
});

test("rejects unusable payloads", () => {
  assert.equal(parseMolqlToolResult(""), null);
  assert.equal(parseMolqlToolResult("   "), null);
  assert.equal(parseMolqlToolResult("no json here"), null);
  assert.equal(parseMolqlToolResult({ type: "molql-selection" }), null);
  assert.equal(parseMolqlToolResult({ molql: "   " }), null);
  assert.equal(parseMolqlToolResult({ molql: 42 }), null);
  assert.equal(parseMolqlToolResult(null), null);
});

test("ignores an unknown mode value", () => {
  assert.deepEqual(parseMolqlToolResult({ molql: "(sel.atom.all)", mode: "nope" }), {
    molql: "(sel.atom.all)",
  });
});
