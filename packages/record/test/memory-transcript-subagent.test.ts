import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "../dist/memory.js";

test("in-memory: transcript round-trip", async () => {
  const store = createInMemoryRecordStore();
  await store.saveSessionTranscript("sess-1", { v: 1, status: "idle", messages: [ { id: "m1", role: "user", parts: [{type:"text",text:"hi"}] } ] });
  const doc = await store.loadSessionTranscript("sess-1");
  assert.ok(doc);
  assert.equal(doc.status, "idle");
  assert.equal((doc.messages as any[]).length, 1);
});

test("in-memory: subagent list-by-parent + upsert", async () => {
  const store = createInMemoryRecordStore();
  const s = { id: "subagent-A", parentSessionId: "sess-1", origin: "subagent" as const, status: "completed" as const, startedAt: "2026-09-20T00:00:00Z" };
  await store.upsertSubagent(s);
  await store.upsertSubagent({ ...s, id: "subagent-B" });
  await store.upsertSubagent({ ...s, id: "subagent-C", parentSessionId: "sess-2" });
  const list = await store.listSubagents("sess-1");
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(x => x.id).sort(), ["subagent-A", "subagent-B"]);
  const one = await store.loadSubagent("subagent-B");
  assert.ok(one);
  assert.equal(one.parentSessionId, "sess-1");
});
