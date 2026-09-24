import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceFileUrl } from "../src/workspace.js";
import { withScope } from "../src/scope.js";

test("workspaceFileUrl carries the worktree claim", () => {
  const scope = { projectId: "p1", worktreeId: "exp-a" };
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { scope });
  assert.equal(url, withScope("/api/workspace/file?path=data%2Fx.csv", scope));
});

test("workspaceFileUrl omits the worktree claim when not scoped", () => {
  const scope = { projectId: "p1" };
  const url = workspaceFileUrl("/api/workspace", "data/x.csv", { scope });
  assert.equal(url, withScope("/api/workspace/file?path=data%2Fx.csv", scope));
  assert.ok(!url.includes("worktreeId="));
});
