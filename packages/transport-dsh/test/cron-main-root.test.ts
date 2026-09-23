import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordStoreLike, Workspace } from "@science-studio/transport";
import { DshRuntimeAdapter, type DshClientLaunchOptions, type DshTurnClient } from "../src/index.js";

/**
 * Scheduled runs are MAIN-only (docs/adr/0025): the cron plugin must be pinned
 * to the Project's `main` root even when the child runs in a linked worktree,
 * while the Project Brief plugin keeps the ACTIVE checkout (`cwd`).
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

/** The `root` a patch's embedded JSON config carries. */
function patchRoot(text: string): string | undefined {
  return /"root":"([^"]*)"/.exec(text)?.[1];
}

async function launched(opts: { projectRoot?: string }): Promise<{ cron: string; project: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cron-main-"));
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
      // The child runs in a LINKED worktree; its cwd is the worktree checkout.
      workspace: workspaceAt("/agent/root/drought-screen/.worktrees/exp-a"),
      project: META,
      ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
    });
    const patches = await Promise.all((seen?.patches ?? []).map((p) => readFile(p, "utf8")));
    return {
      cron: patches.find((p) => p.includes("science-studio-cron")) ?? "",
      project: patches.find((p) => p.includes("science-studio-project")) ?? "",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the cron patch uses the main project root while the Brief keeps the worktree cwd", async () => {
  const { cron, project } = await launched({ projectRoot: "/agent/root/drought-screen" });
  assert.equal(patchRoot(cron), "/agent/root/drought-screen");
  assert.equal(patchRoot(project), "/agent/root/drought-screen/.worktrees/exp-a");
});

test("the cron patch falls back to the launcher cwd without a projectRoot", async () => {
  const { cron } = await launched({});
  assert.equal(patchRoot(cron), "/agent/root/drought-screen/.worktrees/exp-a");
});
