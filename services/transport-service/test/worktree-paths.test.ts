import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeRelPath } from "../src/worktree/paths.js";

test("main worktree path is the project root", () => {
  assert.equal(worktreeRelPath("main"), "");
});

test("a linked worktree lives under .worktrees/<id>", () => {
  assert.equal(worktreeRelPath("exp-a"), ".worktrees/exp-a");
});
