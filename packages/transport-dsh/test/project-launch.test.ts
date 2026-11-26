import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordStoreLike, Workspace } from "@gps/transport";
import { DshRuntimeAdapter, type DshClientLaunchOptions, type DshTurnClient } from "../src/index.js";
import { writeProjectPatch } from "../src/bridge.js";

/**
 * The Project plugin is a launch artifact, exactly like the command bridge: the
 * adapter writes a `--patch` file that mounts `project-plugin.js` into the
 * child, carrying the record-owned Project identity. No harness is spawned.
 */

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };
const noRecordStore: RecordStoreLike = { addRun: async () => {} };

function workspaceAt(agentRoot: string): Workspace {
  return {
    list: async () => ({ path: "", entries: [] }),
    stat: async () => ({}) as never,
    open: async () => ({}) as never,
    write: async () => ({}) as never,
    toAgentPath: (relPath: string) => (relPath === "" ? agentRoot : `${agentRoot}/${relPath}`),
    toWorkspacePath: () => null,
  } as unknown as Workspace;
}

test("writeProjectPatch inserts the project plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-project-launch-"));
  try {
    const file = await writeProjectPatch({
      dir,
      pluginPath: "/opt/ss/project-plugin.js",
      config: { project: META, root: "/w/project", directories: ["docs"] },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: gps-project/);
    assert.match(patch, /project-plugin\.js/);
    assert.match(patch, /"id":"drought-screen"/);
    assert.match(patch, /"root":"\/w\/project"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The launch patch CONTENTS the adapter handed the turn client, per init options. */
async function launchedPatches(project: { id: string; name: string; createdAt: string } | undefined): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-project-launch-"));
  let seen: DshClientLaunchOptions | undefined;
  const adapter = new DshRuntimeAdapter({
    createClient: (options): DshTurnClient => {
      seen = options;
      return { start: async () => {}, close: async () => {}, runTurn: async () => {} };
    },
    transcriptDir: dir,
    bridgeDir: dir,
    bridgePluginPath: "/opt/ss/bridge-plugin.js",
    projectPluginPath: "/opt/ss/project-plugin.js",
    cronPluginPath: "/opt/ss/cron-plugin.js",
  });
  try {
    await adapter.init({
      binding: { runtime: "dsh", config: {} },
      recordStore: noRecordStore,
      workspace: workspaceAt("/agent/root/drought-screen"),
      ...(project === undefined ? {} : { project }),
    });
    assert.ok(seen, "init() must launch a harness client");
    return await Promise.all((seen.patches ?? []).map((patch) => readFile(patch, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the adapter mounts the project plugin when it serves a Project", async () => {
  const patches = await launchedPatches(META);
  assert.equal(
    patches.length,
    6,
    "the bridge, subagent-reporting, project, cron, hpc and worktree patches",
  );
  assert.ok(patches.some((text) => text.includes("drought-screen")), "the project identity rides the launch");
  assert.ok(patches.some((text) => text.includes("gps-cron")), "the cron plugin is mounted");
  assert.ok(patches.some((text) => text.includes("gps-hpc")), "the hpc plugin is mounted (docs/adr/0024)");
  assert.ok(
    patches.some((text) => text.includes("gps-worktree")),
    "the worktree plugin is mounted (docs/adr/0025)",
  );
});

test("the adapter mounts no project plugin without a Project", async () => {
  const patches = await launchedPatches(undefined);
  assert.equal(patches.length, 2, "only the command bridge and the parent-reporting patch are mounted");
  for (const patch of patches) {
    assert.doesNotMatch(patch, /gps-project/);
    assert.doesNotMatch(patch, /gps-cron/);
    assert.doesNotMatch(patch, /gps-hpc/);
    assert.doesNotMatch(patch, /gps-worktree/);
  }
});
