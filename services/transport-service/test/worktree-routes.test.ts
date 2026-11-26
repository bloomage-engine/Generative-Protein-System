import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore } from "@science-studio/record";
import { LocalEnvironmentProvider, LocalPrincipalResolver, NullWorkspace, type RuntimeAdapter } from "@science-studio/transport";
import { createTransportService } from "../src/index.js";
import type { Backend } from "../src/composition.js";
import type { GitRunner } from "../src/worktree/git.js";

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
    const listed = await fetch(`${base}/api/worktrees?projectId=project-default`);
    assert.equal(listed.status, 200);
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(join(projectRoot, "project-default", ".git")));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("create rejects an unsafe project id (400)", async () => {
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
    const res = await fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "../../evil", name: "x" }),
    });
    assert.equal(res.status, 400);
    // Nothing was created outside the root.
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(join(projectRoot, "..", "evil")));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a deleted worktree name can be created again", async () => {
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
  const create = (name: string) =>
    fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default", name }),
    });
  try {
    assert.equal((await create("Experiment A")).status, 201);
    const deleted = await fetch(`${base}/api/worktrees/experiment-a/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await create("Experiment A")).status, 201);
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a session is created under a claimed worktree and listed by it", async () => {
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
    await fetch(`${base}/api/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default", name: "Experiment A" }),
    });
    const created = await fetch(`${base}/api/projects/project-default/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId: "experiment-a" }),
    });
    const { session } = (await created.json()) as { session: { worktreeId?: string } };
    assert.equal(session.worktreeId, "experiment-a");

    const listed = await fetch(`${base}/api/projects/project-default/sessions?worktreeId=experiment-a`);
    const body = (await listed.json()) as { sessions: { worktreeId?: string }[] };
    assert.equal(body.sessions.length, 1);
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("git-backed worktree writes answer 503 while the list stays usable", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  await records.addWorktree({ id: "main", projectId: "project-default", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" });
  await records.addWorktree({ id: "exp-a", projectId: "project-default", name: "A", branch: "exp-a", createdAt: "2026-01-01T00:00:00.000Z" });
  // The exact `{code:-1, stderr}` shape a spawn of a missing `git` yields.
  const git: GitRunner = { run: async () => ({ code: -1, stdout: "", stderr: "spawn git ENOENT" }) };
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
    git,
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
    assert.equal(created.status, 503);

    const list = await fetch(`${base}/api/worktrees?projectId=project-default`);
    assert.equal(list.status, 200);
    const listing = (await list.json()) as {
      worktrees: { id: string; onDiskBranch?: string | null }[];
      gitAvailable?: boolean;
    };
    assert.equal(listing.gitAvailable, false);
    assert.deepEqual(listing.worktrees.map((w) => w.id).sort(), ["exp-a", "main"]);
    assert.equal(listing.worktrees.find((w) => w.id === "main")?.onDiskBranch, undefined);

    const deleted = await fetch(`${base}/api/worktrees/exp-a/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-default" }),
    });
    assert.equal(deleted.status, 503);
    // A 503 means "git could not run", not "the worktree was deleted": the
    // record row survives so a retry on a healthy host can finish the job.
    assert.ok(await records.getWorktree("project-default", "exp-a"));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a session with worktreeId main is created on a fresh project (main auto-ensured)", async () => {
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
    // No worktree/transport request has run: the `main` row does not exist yet.
    const created = await fetch(`${base}/api/projects/project-default/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeId: "main" }),
    });
    assert.equal(created.status, 201);
    const { session } = (await created.json()) as { session: { worktreeId?: string } };
    assert.equal(session.worktreeId, "main");
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a fresh Project workspace lists main without invoking git", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ss-wt-"));
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  let calls = 0;
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records,
    recordDefaults: { projectId: "project-default", projectName: "D", agentId: "main" },
    projectRoot,
    git: {
      run: async () => {
        calls += 1;
        return { code: 0, stdout: "false\n", stderr: "" };
      },
    },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const listed = await fetch(`${base}/api/worktrees?projectId=project-default`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { worktrees: { id: string; exists?: boolean }[] };
    assert.equal(body.worktrees.find((w) => w.id === "main")?.exists, false);
    assert.equal(calls, 0, "a missing cwd must not be mistaken for a missing git");
    const { stat } = await import("node:fs/promises");
    await assert.rejects(() => stat(join(projectRoot, "project-default", ".git")));
  } finally {
    await app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
