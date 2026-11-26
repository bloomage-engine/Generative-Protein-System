import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore } from "@gps/record";
import type { RecordStoreLike } from "@gps/transport";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

/**
 * The CAUTION carried from the Task 5 review: a RESTORED subagent entry's wire
 * key is the `"restored-<id>"` placeholder (the record does not store the wire
 * id), so the harness child log for it does not exist — `readChildTranscript`
 * yields `null` and the old read surface dropped the transcript, even though
 * the record's `row.transcript` holds the child's own settled conversation
 * (docs/adr/0019). The read surface must serve the record for a restored
 * entry; the LIVE case (a real harness child) keeps serving the child log.
 */

const noopClient: DshTurnClient = {
  start: async () => {},
  close: async () => {},
  runTurn: async () => {},
};

test("subagentTranscript serves the record's transcript for a RESTORED subagent", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-restored-sub-"));
  try {
    const record = createInMemoryRecordStore();
    const stableId = "subagent-7f3d9c2e-1111-2222-3333-444455556666";
    // The record row as a PREVIOUS generation left it: settled, with the
    // child's own transcript captured at the time — and no harness child
    // alive any more to read a log from (the harness home below is empty).
    await record.upsertSubagent({
      id: stableId,
      parentSessionId: "sess-1",
      origin: "subagent",
      label: "Literature review",
      provider: "spawn",
      status: "completed",
      stopReason: "completed",
      startedAt: "2026-09-18T00:00:00.000Z",
      finishedAt: "2026-09-18T00:01:00.000Z",
      transcript: {
        v: 1,
        status: "idle",
        messages: [
          { id: "cu1", role: "user", parts: [{ type: "text", text: "summarise this paper" }] },
          { id: "cam1", role: "assistant", parts: [{ type: "text", text: "the child's final answer" }] },
        ],
      },
    });
    const store: RecordStoreLike = {
      addRun: async (run) => {
        await record.addRun(run);
      },
      saveSessionTranscript: (id, doc) => record.saveSessionTranscript(id, doc),
      loadSessionTranscript: (id) => record.loadSessionTranscript(id),
      upsertSubagent: (s) => record.upsertSubagent(s),
      loadSubagent: (id) => record.loadSubagent(id),
      listSubagents: (p) => record.listSubagents(p),
    };

    // A FRESH adapter generation: nothing in memory, no child log on disk.
    const adapter = new DshRuntimeAdapter({
      createClient: () => noopClient,
      bindingDshHome: home,
      transcriptDir: home,
    });
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    try {
      // The panel still lists the restored row (Task 5's `restore`), on the
      // STABLE id — the transcript read is keyed on that same identity.
      const runs = await adapter.subagents("sess-1");
      assert.equal(runs.length, 1, "the restored subagent lists for its parent Session");
      assert.equal(runs[0]!.id, stableId);

      const t = await adapter.subagentTranscript("sess-1", stableId);
      assert.ok(
        t,
        "a restored subagent's transcript must be served — NOT dropped for a missing harness child log",
      );
      assert.equal(t!.id, stableId, "keyed on the stable id (SubagentRun.id)");
      assert.equal(t!.parentId, "sess-1");
      assert.equal(t!.status, "completed", "the ledger's terminal outcome surfaces");
      assert.equal(t!.label, "Literature review");
      assert.equal(t!.stopReason, "completed", "the registry's stop reason surfaces");
      const texts = t!.messages.flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text),
      );
      assert.ok(texts.includes("summarise this paper"), "the child's own messages come from the record");
      assert.ok(texts.includes("the child's final answer"), "…including the child's final answer");

      assert.equal(await adapter.subagentTranscript("sess-2", stableId), null, "a foreign Session does not serve it");
    } finally {
      await adapter.abort();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
