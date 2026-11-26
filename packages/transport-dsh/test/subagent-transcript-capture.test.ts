import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import type { SessionState, StateDelta } from "@gps/transport";
import { sessionState } from "@gps/contract-tests";
import type { RecordStoreLike } from "@gps/transport";
import { createInMemoryRecordStore } from "@gps/record";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";
import { projectKey } from "../src/child-transcript.js";

/**
 * The PRODUCTION caller of `SubagentRegistry.noteTranscript` (Gap-1,
 * docs/adr/0019). Before this fix the method only ever ran from its own unit
 * test, so `subagent.finished` settled the durable row WITHOUT the child's
 * transcript; after a service restart the restored drill-in had nothing to
 * serve. This test drives the real settlement path — a `subagent.finished`
 * notification through the harness subscription — and asserts the RECORD row
 * ends up carrying the child's own transcript (and that a fresh generation
 * serves it on the restored branch). It therefore pins the capture that the
 * restored-read test masked by calling `noteTranscript` directly.
 */

const CHILD = "sub-child-1";
const CHILD_CWD = "/proj/one";

/** Wait for an async (fire-forget) side effect to become observable + true. */
async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the transcript capture to persist");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function session(): SessionState {
  return sessionState({ sessionId: "sess-1" });
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

/** A scripted turn client whose whole purpose here is to expose the harness's
 *  child-wide notification channel (start → subscribeNotifications → emit). */
class NotifyingFakeClient implements DshTurnClient {
  readonly sessionIds: string[] = [];
  private listener: ((notification: HarnessNotification) => void) | null = null;
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  emit(notification: HarnessNotification): void {
    this.listener?.(notification);
  }
  async runTurn(sessionId: string, _text: string, onEvent: (event: SessionEvent) => void): Promise<void> {
    this.sessionIds.push(sessionId);
    const reply = [
      { type: "turn/start", seq: 1, time: Date.now(), data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 2,
        time: Date.now(),
        data: { turn: 1, step: 1, message: { id: "am1", role: "assistant", content: [{ type: "text", text: "delegating now" }], source: { kind: "model" } } },
      },
      { type: "turn/end", seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } },
    ] as unknown as SessionEvent[];
    for (const event of reply) onEvent(event);
  }
}

/** Minimal client for the FRESH (restarted) generation: it only reads, never turns. */
const readonlyClient: DshTurnClient = {
  start: async () => {},
  close: async () => {},
  runTurn: async () => {},
};

test("a subagent.finished notification captures the child's transcript into the record", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-subagent-capture-"));
  try {
    // Lay the harness's own durable child log down where the harness would store
    // it — the LIVE source `captureSubagentTranscript` reads before the child is
    // gone. A `turn/end completed` gives the transcript an explicit status.
    const childDir = join(home, "sessions", projectKey(CHILD_CWD), CHILD);
    await mkdir(childDir, { recursive: true });
    const log = [
      { type: "session", version: 1, id: CHILD, createdAt: 1789655889309, cwd: CHILD_CWD, delegationDepth: 1, isSeeded: false, origin: "subagent" },
      { type: "user/message", seq: 1, time: 1789655889575, data: { content: [{ type: "text", text: "summarise this paper" }] } },
      { type: "assistant/message", seq: 2, time: 1789655911253, data: { turn: 1, step: 1, message: { role: "assistant", id: "cm1", content: [{ type: "text", text: "the child's final answer" }] } } },
      { type: "turn/end", seq: 3, time: 1789656491505, data: { turn: 1, reason: { kind: "completed" } } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    await writeFile(join(childDir, "session.v1.jsonl"), log, "utf8");

    // The durable home is the RECORD (docs/adr/0019) — one store shared by both
    // generations, which is what makes "survive a restart" meaningful here.
    const record = createInMemoryRecordStore();
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

    const client = new NotifyingFakeClient();
    const adapter = new DshRuntimeAdapter({
      createClient: () => client,
      transcriptDir: home,
      bindingDshHome: home,
    });
    await adapter.init({
      binding: { runtime: "dsh", config: {} },
      recordStore: store,
      workspace: { toAgentPath: () => CHILD_CWD, root: CHILD_CWD } as never,
    });
    let stableId: string;
    try {
      // Any user turn brings the child up and attaches the notification listener
      // (the production path a REAL harness child drives on `subagent.*`).
      await collect(
        adapter.run(session(), [
          { type: "add-message", message: { id: "u1", role: "user", content: "delegate a child" } },
        ]),
      );

      const parent = client.sessionIds[0] ?? "root-x";
      client.emit({ method: "subagent.started", params: { parentSessionId: parent, childSessionId: CHILD } });
      client.emit({
        method: "subagent.finished",
        params: { parentSessionId: parent, childSessionId: CHILD, provider: "spawn", status: "ok", stopReason: "completed" },
      });

      // The settle is synchronous (entry settled + `wire→stable` bridged); the
      // capture it kicked is the fire-forget promise — give it room to read the
      // harness log and persist before we read the durable row.
      const runs = await adapter.subagents("sess-1");
      assert.equal(runs.length, 1, "the finished run is listed for its parent Session");
      stableId = runs[0]!.id;
      assert.ok(stableId.startsWith("subagent-"), "keyed on the stable (record) id");

      await until(async () => (await record.loadSubagent(stableId))?.transcript !== undefined);
      const liveRow = (await record.loadSubagent(stableId))!;
      assert.ok(liveRow.transcript, "subagent.finished CAPTURED the child's transcript into the record (the Gap-1 regression)");
      assert.equal(liveRow.transcript!.status, "completed");
      const captured = liveRow.transcript!.messages as Array<{ parts: Array<{ type: string; text?: string }> }>;
      assert.ok(
        captured.some((m) => m.parts.some((p) => p.type === "text" && p.text === "the child's final answer")),
        "the child's own final answer is the captured payload",
      );

      // A FRESH generation over the SAME record (the harness child is long gone):
      // its entry is RESTORED, so its wire key is a placeholder and the drill-in
      // must serve the record-captured transcript — the whole point of the fix.
      const restarted = new DshRuntimeAdapter({
        createClient: () => readonlyClient,
        transcriptDir: home,
        bindingDshHome: home,
      });
      await restarted.init({
        binding: { runtime: "dsh", config: {} },
        recordStore: store,
        workspace: { toAgentPath: () => CHILD_CWD, root: CHILD_CWD } as never,
      });
      try {
        const restored = (await restarted.subagents("sess-1")).find((r) => r.id === stableId);
        assert.ok(restored, "the finished run survives the service restart");
        const t = await restarted.subagentTranscript("sess-1", stableId);
        assert.ok(t, "the restored drill-in SERVES the transcript (a missing harness log is not the answer)");
        assert.equal(t!.id, stableId);
        assert.ok(
          t!.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "the child's final answer")),
          "…with the child's own conversation the capture left in the record",
        );
      } finally {
        await restarted.abort();
      }
    } finally {
      await adapter.abort();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
