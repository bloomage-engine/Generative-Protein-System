import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlRecordStore } from "../dist/jsonl.js";

async function makeStore(): Promise<[Awaited<ReturnType<typeof createJsonlRecordStore>>, string, () => Promise<void>]> {
  const d = await mkdtemp(join(tmpdir(), "rec-" ));
  const store = await createJsonlRecordStore(join(d, "record.jsonl"));
  return [store, d, () => import("node:fs/promises").then(fs => fs.rm(d, { recursive: true, force: true }))];
}

test("jsonl: transcript survives a store restart", async () => {
  const [store, d] = await makeStore();
  await store.saveSessionTranscript("sess-1", { v: 1, status: "idle", messages: [ { id: "m", role: "user", parts: [{type:"text",text:"hi"}] } ] });
  const doc = await store.loadSessionTranscript("sess-1");
  assert.ok(doc);
  assert.equal((doc.messages as any[]).length, 1);

  // A fresh store over the same dir restores the transcript from disk.
  const store2 = await createJsonlRecordStore(join(d, "record.jsonl"));
  const doc2 = await store2.loadSessionTranscript("sess-1");
  assert.ok(doc2);
  assert.equal((doc2.messages as any[]).length, 1);
});

test("jsonl: subagents list-by-parent + upsert + survive restart", async () => {
  const [store, d, cleanup] = await makeStore();
  const s = { id: "subagent-A", parentSessionId: "sess-1", origin: "subagent" as const, status: "running" as const, startedAt: "2026-09-20T00:00:00Z" };
  await store.upsertSubagent(s);
  const list = await store.listSubagents("sess-1");
  assert.equal(list.length, 1);
  assert.ok(list[0]);
  assert.equal(list[0].id, "subagent-A");

  // A fresh store over the same dir restores the subagent from disk.
  const store2 = await createJsonlRecordStore(join(d, "record.jsonl"));
  const reloaded = await store2.loadSubagent("subagent-A");
  assert.ok(reloaded);
  assert.equal(reloaded!.id, "subagent-A");
  assert.equal(reloaded!.parentSessionId, "sess-1");

  await cleanup();
});

test("jsonl: deleteSession cascades the transcript + its subagents", async () => {
  const [store, d, cleanup] = await makeStore();
  await store.addSession({ id: "sess-1", projectId: "proj-1", agentId: "agent-1", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" });
  await store.saveSessionTranscript("sess-1", { v: 1, status: "idle", messages: [] });
  await store.upsertSubagent({ id: "subagent-A", parentSessionId: "sess-1", origin: "subagent", status: "running", startedAt: "2026-09-20T00:00:00Z" });
  // A subagent owned by a DIFFERENT session must survive the cascade.
  await store.upsertSubagent({ id: "subagent-B", parentSessionId: "sess-2", origin: "subagent", status: "running", startedAt: "2026-09-20T00:00:00Z" });

  await store.deleteSession("sess-1");

  assert.equal(await store.loadSessionTranscript("sess-1"), null);
  assert.deepEqual(await store.listSubagents("sess-1"), []);
  assert.equal((await store.listSubagents("sess-2")).length, 1);
  // The transcript file really is gone from disk, not just unreadable.
  const transcriptPath = join(d, "transcripts", encodeURIComponent("sess-1") + ".json");
  await assert.rejects(stat(transcriptPath), (err: NodeJS.ErrnoException) => err.code === "ENOENT");

  await cleanup();
});
