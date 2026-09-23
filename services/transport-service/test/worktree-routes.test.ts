import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore } from "@science-studio/record";
import { LocalEnvironmentProvider, LocalPrincipalResolver, NullWorkspace, type RuntimeAdapter } from "@science-studio/transport";
import { createTransportService } from "../src/index.js";
import type { Backend } from "../src/composition.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;

test("create, list, and delete a worktree through the routes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const created = await fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default", name: "Experiment A" }),
    });
    assert.equal(created.status, 201);
    const { worktree } = (await created.json()) as { worktree: { id: string; branch: string } };
    assert.equal(worktree.id, "experiment-a");
    assert.equal(worktree.branch, "experiment-a");

    const list = await fetch(`${base}/api/worktrees?projectId=project-default`);
    const listed = (await list.json()) as { worktrees: { id: string }[] };
    assert.deepEqual(listed.worktrees.map((w) => w.id).sort(), ["experiment-a", "main"]);

    const denied = await fetch(`${base}/api/worktrees/main/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(denied.status, 403);

    const deleted = await fetch(`${base}/api/worktrees/experiment-a/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(deleted.status, 200);
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("listing does not create a repository", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await fetch(`${base}/api/worktrees?projectId=project-default`);
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(join(projectRoot, "project-default", ".git")));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
