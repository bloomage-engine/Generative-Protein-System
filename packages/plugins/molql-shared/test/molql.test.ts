import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMolqlToolResult } from "@science-studio/molstar-viewer/directive";
import {
  createMolqlResult,
  fetchInteractions,
  SERVICE_URL,
  INTERACTION_TOOL_NAME,
} from "../src/molql.js";

// ── constants ──

test("INTERACTION_TOOL_NAME is computeInteraction", () => {
  assert.equal(INTERACTION_TOOL_NAME, "computeInteraction");
});

test("SERVICE_URL defaults to localhost:3001", () => {
  assert.equal(SERVICE_URL, "http://127.0.0.1:3001");
});

// ── createMolqlResult ──

test("returns molql-selection type discriminator", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)" });
  assert.equal(result.type, "molql-selection");
});

test("trims whitespace from molql expression", () => {
  const result = createMolqlResult({ molql: "  (sel.atom.all)  " });
  assert.equal(result.molql, "(sel.atom.all)");
});

test("defaults mode to select", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)" });
  assert.equal(result.mode, "select");
});

test("passes through highlight mode", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)", mode: "highlight" });
  assert.equal(result.mode, "highlight");
});

test("treats unknown mode as select", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)", mode: "invalid" });
  assert.equal(result.mode, "select");
});

test("defaults focus to true", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)" });
  assert.equal(result.focus, true);
});

test("passes through focus=false", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)", focus: false });
  assert.equal(result.focus, false);
});

test("includes description when provided", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)", description: "all atoms" });
  assert.equal(result.description, "all atoms");
});

test("omits description when undefined", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)" });
  assert.equal(result.description, undefined);
});

test("omits description when empty string", () => {
  const result = createMolqlResult({ molql: "(sel.atom.all)", description: "" });
  assert.equal(result.description, undefined);
});

test("output is parseable by parseMolqlToolResult", () => {
  const result = createMolqlResult({
    molql: "(sel.atom.chains (= atom.chain A))",
    description: "chain A",
    focus: true,
    mode: "select",
  });
  const parsed = parseMolqlToolResult(result);
  assert.deepEqual(parsed, {
    molql: "(sel.atom.chains (= atom.chain A))",
    description: "chain A",
    focus: true,
    mode: "select",
  });
});

test("parseMolqlToolResult accepts all mode/focus combinations", () => {
  for (const mode of ["select", "highlight"] as const) {
    for (const focus of [true, false]) {
      const result = createMolqlResult({ molql: "(sel.atom.all)", mode, focus });
      const parsed = parseMolqlToolResult(result);
      assert.ok(parsed, `mode=${mode} focus=${focus} should parse`);
      assert.equal(parsed!.mode, mode);
      assert.equal(parsed!.focus, focus);
    }
  }
});

// ── fetchInteractions ──

test("constructs URL with encoded parameters", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ table: "| a | b |\n|---|---|" }), { status: 200 });
  };
  try {
    await fetchInteractions({ project: "proj/1", path: "a b.pdb", molql: "(sel.atom.all)" });
    assert.ok(capturedUrl.includes("project=proj%2F1"));
    assert.ok(capturedUrl.includes("path=a%20b.pdb"));
    assert.ok(capturedUrl.includes("molql=(sel.atom.all)"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns table from successful response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ table: "| type | atom |\n|------|------|" }), { status: 200 });
  try {
    const result = await fetchInteractions({ project: "p", path: "f.pdb", molql: "(sel.atom.all)" });
    assert.equal(result.table, "| type | atom |\n|------|------|");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("throws on non-ok response with error body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  try {
    await assert.rejects(
      () => fetchInteractions({ project: "p", path: "f.pdb", molql: "(sel.atom.all)" }),
      { message: "not found" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("throws on non-ok response with status fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad", { status: 500 });
  try {
    await assert.rejects(
      () => fetchInteractions({ project: "p", path: "f.pdb", molql: "(sel.atom.all)" }),
      { message: "interaction service answered 500" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handles missing table field in response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  try {
    const result = await fetchInteractions({ project: "p", path: "f.pdb", molql: "(sel.atom.all)" });
    assert.equal(result.table, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
