import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKTREE_ID,
  createInMemoryRecordStore,
  createJsonlRecordStore,
  sessionWorktreeId,
  type Project,
  type RecordStore,
  type Run,
  type Session,
  type Worktree,
} from "../src/index.js";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Metabolism",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  id: "main",
  projectId: "p1",
  name: "main",
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  projectId: "p1",
  agentId: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  sessionId: "s1",
  projectId: "p1",
  status: "completed",
  agentId: "main",
  parameters: {},
  input: "hi",
  ...over,
});

async function bothStores(runFn: (make: () => Promise<RecordStore>) => Promise<void>): Promise<void> {
  await runFn(async () => createInMemoryRecordStore());
  const dir = await mkdtemp(join(tmpdir(), "gps-record-worktree-"));
  try {
    await runFn(async () => createJsonlRecordStore(join(dir, "record.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("worktrees satisfy the RecordStore contract in both stores", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));

    assert.deepEqual(
      (await store.listWorktrees("p1")).map((w) => w.id),
      ["main", "exp-a"],
    );
    assert.equal((await store.getWorktree("p1", "exp-a"))?.branch, "exp/a");
    assert.equal(await store.getWorktree("p1", "missing"), null);

    await store.archiveWorktree("p1", "exp-a", "2026-02-01T00:00:00.000Z");
    assert.deepEqual(
      (await store.listWorktrees("p1")).map((w) => w.id),
      ["main"],
    );
    assert.deepEqual(
      (await store.listWorktrees("p1", { includeArchived: true })).map((w) => w.id),
      ["main", "exp-a"],
    );
    await store.unarchiveWorktree("p1", "exp-a");
    assert.equal((await store.getWorktree("p1", "exp-a"))?.archivedAt, undefined);

    await store.updateWorktree("p1", "exp-a", { name: "Renamed" });
    assert.equal((await store.getWorktree("p1", "exp-a"))?.name, "Renamed");

    // Rows are copies.
    const fetched = (await store.listWorktrees("p1"))[0]!;
    fetched.name = "mutated";
    assert.equal((await store.getWorktree("p1", "main"))?.name, "main");

    // Two Projects may each have a `main` worktree without shadowing (the id is
    // only unique WITHIN a project).
    await store.createProject(project({ id: "p2", name: "Other" }));
    await store.addWorktree(worktree({ id: "main", projectId: "p2" }));
    assert.equal((await store.getWorktree("p1", "main"))?.projectId, "p1");
    assert.equal((await store.getWorktree("p2", "main"))?.projectId, "p2");
  });
});

test("deleting a worktree cascades its sessions and runs", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));
    await store.addSession(session({ id: "s1", worktreeId: "exp-a" }));
    await store.addSession(session({ id: "s2", worktreeId: "main" }));
    await store.addRun(run({ id: "r1", sessionId: "s1" }));
    await store.addRun(run({ id: "r2", sessionId: "s2" }));

    await store.deleteWorktree("p1", "exp-a");
    assert.equal(await store.getWorktree("p1", "exp-a"), null);
    assert.equal(await store.getSession("s1"), null);
    assert.equal((await store.getSession("s2"))?.id, "s2");
    assert.deepEqual(
      (await store.listRuns("p1")).map((r) => r.id),
      ["r2"],
    );
  });
});

test("deleting a project cascades its worktrees", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject(project());
    await store.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));
    await store.deleteProject("p1");
    assert.deepEqual(await store.listWorktrees("p1", { includeArchived: true }), []);
  });
});

test("sessionWorktreeId defaults a legacy session to main", () => {
  assert.equal(sessionWorktreeId(session()), DEFAULT_WORKTREE_ID);
  assert.equal(sessionWorktreeId(session({ worktreeId: "exp-a" })), "exp-a");
});

test("JSONL worktree rows and legacy sessions survive a reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-worktree-reopen-"));
  try {
    const path = join(dir, "record.jsonl");
    const first = await createJsonlRecordStore(path);
    await first.createProject(project());
    await first.addWorktree(worktree({ id: "exp-a", name: "Experiment A", branch: "exp/a" }));
    // A session persisted WITHOUT a worktreeId (the pre-worktree shape).
    await first.addSession({ ...session({ id: "s-legacy" }), worktreeId: undefined });
    await first.addSession(session({ id: "s-linked", worktreeId: "exp-a" }));

    const second = await createJsonlRecordStore(path);
    assert.equal((await second.getWorktree("p1", "exp-a"))?.branch, "exp/a");
    assert.deepEqual(
      (await second.listWorktrees("p1")).map((w) => w.id),
      ["exp-a"],
    );
    assert.equal(sessionWorktreeId((await second.getSession("s-legacy"))!), "main");
    assert.equal((await second.getSession("s-linked"))?.worktreeId, "exp-a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
