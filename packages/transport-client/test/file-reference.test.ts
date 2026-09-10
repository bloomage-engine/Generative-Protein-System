import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFileReference, type FileReferenceContext } from "../src/file-reference.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";
const ctx: FileReferenceContext = {
  toWorkspacePath: (agentPath) =>
    agentPath === AGENT_ROOT
      ? ""
      : agentPath.startsWith(`${AGENT_ROOT}/`)
        ? agentPath.slice(AGENT_ROOT.length + 1)
        : null,
};

test("resolves plain workspace-relative paths", () => {
  assert.deepEqual(resolveFileReference("analysis/plot.png", ctx), {
    workspacePath: "analysis/plot.png",
    name: "plot.png",
  });
  assert.deepEqual(resolveFileReference("./analysis/plot.png", ctx), {
    workspacePath: "analysis/plot.png",
    name: "plot.png",
  });
  assert.deepEqual(resolveFileReference("results.csv?v=2", ctx), {
    workspacePath: "results.csv",
    name: "results.csv",
  });
});

test("resolves the injected science://workspace scheme", () => {
  assert.deepEqual(resolveFileReference("science://workspace/analysis/plot.png", ctx), {
    workspacePath: "analysis/plot.png",
    name: "plot.png",
  });
  assert.equal(resolveFileReference("science://other/analysis/plot.png", ctx), null);
  assert.equal(resolveFileReference("science://workspace/", ctx), null);
});

test("resolves file:// URIs under the agent root and rejects those outside it", () => {
  assert.deepEqual(resolveFileReference(`file://${AGENT_ROOT}/a/x.csv`, ctx), {
    workspacePath: "a/x.csv",
    name: "x.csv",
  });
  assert.equal(resolveFileReference("file:///etc/passwd", ctx), null);
});

test("rejects traversal, absolute paths, and external schemes", () => {
  const rejected = [
    "../outside.txt",
    "a/../../outside.txt",
    "/etc/passwd",
    "https://example.com/x.csv",
    "http://example.com/x.csv",
    "mailto:someone@example.com",
    "data:text/plain,hi",
    "#section",
    "//example.com/x.csv",
    "",
    "   ",
  ];
  for (const href of rejected) {
    assert.equal(resolveFileReference(href, ctx), null, `must reject ${JSON.stringify(href)}`);
  }
});

test("a custom scheme can be configured", () => {
  const custom: FileReferenceContext = { ...ctx, scheme: "ss" };
  assert.deepEqual(resolveFileReference("ss://workspace/a/b.txt", custom), {
    workspacePath: "a/b.txt",
    name: "b.txt",
  });
  assert.equal(resolveFileReference("science://workspace/a/b.txt", custom), null);
});

test("relative paths resolve without a mapping; file:// needs one", () => {
  assert.deepEqual(resolveFileReference("a/b.txt", {}), {
    workspacePath: "a/b.txt",
    name: "b.txt",
  });
  assert.equal(resolveFileReference(`file://${AGENT_ROOT}/a/b.txt`, {}), null);
});
