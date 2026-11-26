import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorktreePatch } from "../src/bridge.js";
import { DshRuntimeAdapter } from "../src/adapter.js";
import type { DshClientLaunchOptions, DshTurnClient } from "../src/client.js";

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
    assert.match(patch, /id: gps-worktree/);
    assert.match(patch, /worktree-plugin\.js/);
    assert.match(patch, /"worktree":\{"id":"exp-a"/);
    assert.match(patch, /"service":"http:\/\/127\.0\.0\.1:3123"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const noRecordStore = { addRun: async () => {} };

async function mountedPatches(opts: {
  project?: { id: string; name: string; createdAt: string };
  worktree?: { id: string; name: string; branch: string; root: string };
}): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-worktree-mount-"));
  let seen: DshClientLaunchOptions | undefined;
  const adapter = new DshRuntimeAdapter({
    createClient: (options): DshTurnClient => { seen = options; return { start: async () => {}, close: async () => {}, runTurn: async () => {} }; },
    bridgeDir: dir,
    bridgePluginPath: "/opt/ss/bridge-plugin.js",
    worktreePluginPath: "/opt/ss/worktree-plugin.js",
  });
  await adapter.init({
    binding: { runtime: "dsh", config: {} },
    recordStore: noRecordStore,
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });
  const files = seen?.patches ?? [];
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

test("the adapter mounts the worktree plugin for a real project", async () => {
  const patches = await mountedPatches({ project: META, worktree: WT });
  assert.ok(patches.some((p) => /gps-worktree/.test(p)));
  assert.ok(patches.some((p) => /"worktree":\{"id":"exp-a"/.test(p)));
});

test("without a project the worktree plugin is not mounted", async () => {
  const patches = await mountedPatches({});
  assert.ok(!patches.some((p) => /gps-worktree/.test(p)));
});
