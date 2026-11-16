import { test } from "node:test";
import assert from "node:assert/strict";
import { treeKillCommand } from "../src/shared/process-tree.js";

test("Windows kills the whole process tree, other platforms use signals", () => {
  assert.deepEqual(treeKillCommand("win32", 4321), {
    command: "taskkill",
    args: ["/pid", "4321", "/T", "/F"],
  });
  assert.equal(treeKillCommand("linux", 4321), null);
  assert.equal(treeKillCommand("darwin", 4321), null);
});
