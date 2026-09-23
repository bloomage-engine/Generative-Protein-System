import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorktreePatch } from "../src/bridge.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };
const WT = { id: "exp-a", name: "Experiment A", branch: "exp-a", root: "/w/.worktrees/exp-a" };

test("writeWorktreePatch inserts the plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-worktree-launch-"));
  try {
    const file = await writeWorktreePatch({
      dir,
      pluginPath: "/opt/ss/worktree-plugin.js",
      config: { project: META, worktree: WT, service: "http://127.0.0.1:3123" },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: science-studio-worktree/);
    assert.match(patch, /worktree-plugin\.js/);
    assert.match(patch, /"worktree":\{"id":"exp-a"/);
    assert.match(patch, /"service":"http:\/\/127\.0\.0\.1:3123"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
