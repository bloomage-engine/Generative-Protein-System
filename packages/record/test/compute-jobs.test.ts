import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryRecordStore,
  createJsonlRecordStore,
  type ComputeJob,
  type RecordStore,
} from "../src/index.js";

function job(over: Partial<ComputeJob> = {}): ComputeJob {
  return {
    id: `cjob-test-${Math.random().toString(36).slice(2, 8)}`,
    projectId: "p1",
    endpointId: "cluster-a",
    kind: "slurm",
    remoteJobId: "12345",
    name: "md run",
    state: "submitted",
    submittedAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...over,
  };
}

async function bothStores(run: (make: () => Promise<RecordStore>) => Promise<void>): Promise<void> {
  await run(async () => createInMemoryRecordStore());
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  try {
    await run(async () => createJsonlRecordStore(join(dir, "record.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Compute Job rows upsert, load and list by project — both stores", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
    await store.createProject({ id: "p2", name: "P2", createdAt: "2026-01-01T00:00:00.000Z" });
    const a = job();
    await store.upsertComputeJob(a);
    await store.upsertComputeJob(job({ projectId: "p2" }));
    const loaded = await store.loadComputeJob(a.id);
    assert.deepEqual(loaded, a);
    const list = await store.listComputeJobs("p1");
    assert.equal(list.length, 1);
    // an update replaces the row in place (idempotent upsert).
    await store.upsertComputeJob({ ...a, state: "running", startedAt: "2026-09-22T00:01:00.000Z" });
    const again = await store.listComputeJobs("p1");
    assert.equal(again.length, 1);
    assert.equal(again[0]?.state, "running");
  });
});

test("deleting a Project cascades its Compute Job rows; a Session delete does not (docs/adr/0024)", async () => {
  await bothStores(async (make) => {
    const store = await make();
    await store.createProject({ id: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z" });
    await store.addSession({
      id: "s1",
      projectId: "p1",
      agentId: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const kept = job({ sessionKey: "s1" });
    await store.upsertComputeJob(kept);
    await store.deleteSession("s1");
    assert.ok(await store.loadComputeJob(kept.id), "a Session delete must not touch the ledger");
    await store.deleteProject("p1");
    assert.equal(await store.loadComputeJob(kept.id), null);
    assert.deepEqual(await store.listComputeJobs("p1"), []);
  });
});

test("a persisted Compute Job row survives a reopen (JSONL durability)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  try {
    const path = join(dir, "record.jsonl");
    const store = await createJsonlRecordStore(path);
    const row = job({ name: "persist me" });
    await store.upsertComputeJob(row);
    const reopened = await createJsonlRecordStore(path);
    const loaded = await reopened.loadComputeJob(row.id);
    assert.equal(loaded?.name, "persist me");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
