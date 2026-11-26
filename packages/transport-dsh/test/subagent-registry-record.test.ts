import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@gps/record";
import type { RecordStoreLike } from "@gps/transport";
import { SubagentRegistry } from "../src/subagents.js";

test("dsh registry: stable id + parent lineage + transcript capture — all via the record store", async () => {
  const record = createInMemoryRecordStore();
  // The record's `addRun` returns the row (`Promise<Run>`); the registry seam
  // wants `Promise<void>`. The service wraps its record the same way — the
  // registry sees a `RecordStoreLike` with all 5 subagent methods present.
  const like: RecordStoreLike = {
    addRun: async (run) => {
      await record.addRun(run);
    },
    upsertSubagent: (s) => record.upsertSubagent(s),
    loadSubagent: (id) => record.loadSubagent(id),
    listSubagents: (p) => record.listSubagents(p),
  };
  const resolve = (rootHarnessId: string) => (rootHarnessId === "root-1" ? "sess-1" : undefined);
  const reg = new SubagentRegistry(resolve, () => "2026-09-20T00:00:00Z", like);
  await reg.ready();

  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "researcher" });
  reg.noteFinished("child-1", { status: "ok", stopReason: "completed" });
  reg.noteTranscript("child-1", {
    v: 1,
    status: "idle",
    messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "do this" }] }],
  });
  await reg.flush();

  // Panel: the id is the STABLE id (the record's key, not the wire child id),
  // and the parent is the resolved Generative Protein System session key.
  const panel = reg.list("sess-1");
  assert.equal(panel.length, 1);
  const stableId = panel[0]!.id;
  assert.ok(stableId.startsWith("subagent-"), "the stable id is a subagent-<uuid>");
  assert.notEqual(stableId, "child-1", "the panel id is NOT the wire child id");
  assert.equal(panel[0]!.parentId, "sess-1");
  assert.equal(panel[0]!.status, "completed");
  assert.equal(panel[0]!.label, "researcher");

  // The registry resolves the wire id back to the stable id (and the other way),
  // so the transcript surface and the panel stay keyed on the same identity.
  assert.equal(reg.stableIdFor("child-1"), stableId);
  assert.equal(reg.harnessIdFor(stableId), "child-1");

  // The record row (the durable) is keyed by the stable id.
  const row = await record.loadSubagent(stableId);
  assert.ok(row);
  assert.equal(row!.parentSessionId, "sess-1");
  assert.equal(row!.origin, "subagent");
  assert.equal(row!.status, "completed");
  assert.equal(row!.label, "researcher");
  assert.ok(row!.transcript, "the child's settled transcript is captured in the record row");
  assert.equal(row!.transcript!.status, "idle");
  const text = (row!.transcript!.messages as Array<{ parts: Array<{ type: string; text?: string }> }>)[0]!.parts;
  assert.ok(text.some((p) => p.type === "text" && p.text === "do this"), "the transcript messages survive the store");
});
