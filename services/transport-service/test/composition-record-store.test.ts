import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlRecordStore, type Subagent } from "@gps/record";
import { toRecordStoreLike } from "../src/composition.js";

/**
 * The composition narrows the authoritative `RecordStore` to the adapter-facing
 * `RecordStoreLike` before handing it to `adapter.init`. That view must keep the
 * DURABLE extensions the record owns (session transcript + subagents,
 * docs/adr/0019): the dsh adapter writes its canonical transcript through this
 * view, and on restart reads it back through it. A view that only forwards
 * `addRun` silently drops every turn — a restart then shows an empty
 * conversation (the reported "messages lost after restart" symptom).
 */
test("toRecordStoreLike keeps the durable transcript/subagent methods across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svc-record-narrow-"));
  const path = join(dir, "record.jsonl");
  try {
    const records = await createJsonlRecordStore(path);
    // What the service hands `adapter.init({ recordStore })`.
    const view = toRecordStoreLike(records);

    await view.saveSessionTranscript?.("sess-1", {
      v: 1,
      status: "idle",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "am1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
    });
    const subagent: Subagent = {
      id: "subagent-A",
      parentSessionId: "sess-1",
      origin: "subagent",
      status: "completed",
      startedAt: "2026-09-20T00:00:00.000Z",
    };
    await view.upsertSubagent?.(subagent);

    // Restart: a fresh store over the SAME path, narrowed the same way.
    const restarted = await createJsonlRecordStore(path);
    const view2 = toRecordStoreLike(restarted);

    const loaded = await view2.loadSessionTranscript?.("sess-1");
    assert.ok(loaded, "the narrowed view restores the saved session transcript after a restart");
    assert.deepEqual(
      (loaded?.messages as { id: string }[]).map((m) => m.id),
      ["u1", "am1"],
      "the restored transcript carries the whole exchange",
    );
    const sub = await view2.loadSubagent?.("subagent-A");
    assert.equal(sub?.id, "subagent-A", "the narrowed view restores the durable subagent row");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
