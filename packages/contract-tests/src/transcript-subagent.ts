/**
 * Conformance suite for the record's DURABLE transcript + subagent storage
 * (docs/adr/0019). Every `RecordStore` implementation must let the runtime's
 * canonical conversation view and its stably-identified subagents round-trip:
 * save a transcript and read it back by key, scope subagents to their parent
 * session, upsert idempotently, and report a missing key as `null`/`[]` rather
 * than throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecordStore } from "@gps/record";

export interface TranscriptAndSubagentCase {
  store: RecordStore;
  dispose?: () => Promise<void>;
}

export function testTranscriptAndSubagent(
  name: string,
  makeCase: () => Promise<TranscriptAndSubagentCase>,
): void {
  test(name, async () => {
    const { store, dispose } = await makeCase();
    try {
      // Transcript: round-trip + isolation by key + idempotent overwrite.
      const msg1 = { id: "m-1", role: "user", parts: [{ type: "text", text: "Hello" }] };
      await store.saveSessionTranscript("sess-x", { v: 1, status: "running", messages: [msg1] });
      const got = await store.loadSessionTranscript("sess-x");
      assert.ok(got);
      assert.equal(got!.v, 1);
      assert.equal(got!.status, "running");
      assert.deepEqual(got!.messages, [msg1]);
      assert.equal(await store.loadSessionTranscript("sess-Y"), null);
      await store.saveSessionTranscript("sess-x", { v: 1, status: "idle", messages: [] });
      const got2 = await store.loadSessionTranscript("sess-x");
      assert.equal(got2!.status, "idle");
      assert.equal((got2!.messages as unknown[]).length, 0);

      // Subagent: upsert + stable key + parent scoping.
      const subA = { id: "subagent-a", parentSessionId: "sess-x", origin: "subagent" as const, status: "running" as const, startedAt: "2026-09-20T00:00:00Z" };
      await store.upsertSubagent(subA);
      await store.upsertSubagent({ ...subA, id: "subagent-b", parentSessionId: "sess-Y" });
      assert.deepEqual((await store.listSubagents("sess-x")).map((s) => s.id), ["subagent-a"]);
      assert.deepEqual((await store.listSubagents("sess-Y")).map((s) => s.id), ["subagent-b"]);
      const one = await store.loadSubagent("subagent-b");
      assert.ok(one);
      assert.equal(one!.parentSessionId, "sess-Y");
      assert.equal(await store.loadSubagent("subagent-missing"), null);
      assert.deepEqual(await store.listSubagents("sess-who"), []);
    } finally {
      await dispose?.();
    }
  });
}
