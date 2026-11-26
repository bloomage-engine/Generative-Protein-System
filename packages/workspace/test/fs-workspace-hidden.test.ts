import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspace } from "../src/index.js";

test("hiddenEntries are omitted from listings at any depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "gps-hidden-"));
  try {
    await mkdir(join(root, ".worktrees", "exp-a"), { recursive: true });
    await mkdir(join(root, "data", ".git"), { recursive: true });
    await writeFile(join(root, "data", "x.csv"), "a\n");
    const ws = new FsWorkspace(root, { agentRoot: root, hiddenEntries: [".git", ".worktrees"] });
    assert.deepEqual((await ws.list()).entries.map((e) => e.name), ["data"]);
    assert.deepEqual((await ws.list("data")).entries.map((e) => e.name), ["x.csv"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
