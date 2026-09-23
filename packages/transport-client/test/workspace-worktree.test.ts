import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceFileUrl } from "../src/workspace.js";

test("workspaceFileUrl carries the worktree claim", () => {
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { project: "p1", worktree: "exp-a" });
  assert.match(url, /project=p1/);
  assert.match(url, /worktreeId=exp-a/);
});

test("workspaceFileUrl omits the worktree claim when not scoped", () => {
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { project: "p1" });
  assert.ok(!url.includes("worktreeId="));
});
