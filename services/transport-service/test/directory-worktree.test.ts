import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@gps/record";
import { createRecordDirectory, WorktreeNotFoundError } from "../src/directory.js";

const make = async () => {
  const store = await createInMemoryRecordStore();
  await store.createProject({ id: "p1", name: "P", createdAt: "2026-01-01T00:00:00.000Z" });
  let n = 0;
  const directory = createRecordDirectory({
    store,
    newId: () => `sess-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { store, directory };
};

test("ensureWorktree auto-creates exactly one main row", async () => {
  const { store, directory } = await make();
  const first = await directory.ensureWorktree("p1");
  assert.equal(first.id, "main");
  assert.equal(first.branch, "main");
  const second = await directory.ensureWorktree("p1");
  assert.equal(second.id, "main");
  assert.equal((await store.listWorktrees("p1", { includeArchived: true })).length, 1);
});

test("mintWorktreeId slugs the name and suffixes collisions", async () => {
  const { directory } = await make();
  assert.equal(await directory.mintWorktreeId("p1", "Experiment A"), "experiment-a");
  await directory.addWorktree("p1", { id: "experiment-a", name: "Experiment A", branch: "experiment-a" });
  assert.equal(await directory.mintWorktreeId("p1", "Experiment A"), "experiment-a-2");
});

test("mintWorktreeId never yields the reserved main id", async () => {
  const { directory } = await make();
  assert.equal(await directory.mintWorktreeId("p1", "main"), "main-2");
});

test("requireWorktree rejects an unknown id and accepts main", async () => {
  const { directory } = await make();
  await directory.ensureWorktree("p1");
  assert.equal((await directory.requireWorktree("p1", "main")).id, "main");
  await assert.rejects(() => directory.requireWorktree("p1", "nope"), WorktreeNotFoundError);
});

test("createSession stamps the worktree and resolveOrCreateSession defaults to main", async () => {
  const { directory } = await make();
  await directory.ensureWorktree("p1");
  const explicit = await directory.createSession("p1", { worktreeId: "exp-a" });
  assert.equal(explicit.worktreeId, "exp-a");
  const lazy = await directory.resolveOrCreateSession("p1", "thread-1");
  assert.equal(lazy.worktreeId, "main");
  const lazy2 = await directory.resolveOrCreateSession("p1", "thread-2", "exp-a");
  assert.equal(lazy2.worktreeId, "exp-a");
});
