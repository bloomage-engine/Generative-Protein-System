import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInlineFileReference } from "../src/workspace-file-link.js";

test("resolves extension-led workspace paths to a file ref", () => {
  assert.deepEqual(resolveInlineFileReference("boltz_input.pdb"), {
    workspacePath: "boltz_input.pdb",
    name: "boltz_input.pdb",
  });
  assert.deepEqual(resolveInlineFileReference("data/raw.csv"), {
    workspacePath: "data/raw.csv",
    name: "raw.csv",
  });
  assert.deepEqual(resolveInlineFileReference("analysis/plots/result.png"), {
    workspacePath: "analysis/plots/result.png",
    name: "result.png",
  });
  assert.deepEqual(resolveInlineFileReference("archive.tar.gz"), {
    workspacePath: "archive.tar.gz",
    name: "archive.tar.gz",
  });
});

test("rejects non-file inline code", () => {
  for (const text of [
    "",
    "   ",
    "project_update",
    "True",
    "git status",
    "v1.2.3",
    "file.",
    "and/or",
    "data/",
    "24/7",
  ]) {
    assert.equal(resolveInlineFileReference(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});

test("rejects schemes, absolute paths, mentions and escapes", () => {
  for (const text of [
    "http://example.com/plot.png",
    "https://example.com/a/b.csv",
    "science://workspace/a.pdb",
    "/etc/passwd.txt",
    "@proj/data/raw.csv",
    "../outside.txt",
  ]) {
    assert.equal(resolveInlineFileReference(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});

test("trims surrounding whitespace before resolving", () => {
  assert.deepEqual(resolveInlineFileReference("  data/raw.csv  "), {
    workspacePath: "data/raw.csv",
    name: "raw.csv",
  });
});
