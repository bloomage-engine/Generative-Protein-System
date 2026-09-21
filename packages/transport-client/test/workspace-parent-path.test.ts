import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceParentPath } from "../src/workspace.js";

test("workspaceParentPath walks up exactly one directory", () => {
  assert.equal(workspaceParentPath(""), "");
  assert.equal(workspaceParentPath("a"), "");
  assert.equal(workspaceParentPath("a/b"), "a");
  assert.equal(workspaceParentPath("a/b/c"), "a/b");
});

test("workspaceParentPath ignores trailing slashes", () => {
  assert.equal(workspaceParentPath("a/b/"), "a");
  assert.equal(workspaceParentPath("a/"), "");
});
