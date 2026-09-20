import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { RecordStoreLike, SessionState, StateDelta } from "@science-studio/transport";
import { createInMemoryRecordStore } from "@science-studio/record";
import { sessionState } from "@science-studio/contract-tests";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

/** A scripted turn client: one committed assistant reply, then the turn ends. */
class FakeDshClient implements DshTurnClient {
  started = false;
  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    _text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    onEvent(ev("turn/start", { turn: 1 }, 1));
    onEvent(
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "am1",
            role: "assistant",
            content: [{ type: "text", text: "Hello from dsh." }],
            source: { kind: "model" },
          },
        },
        2,
      ),
    );
    onEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3));
    void sessionId;
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

test("adapter: a settled turn's transcript lands in the record store (not a mirror file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rt-"));
  try {
    // 1. The REAL record store (the service uses JSONL; parity here) is the
    //    durable home for both the Run and the session transcript — dsh has no
    //    adapter-owned transcript mirror any more (docs/adr/0019).
    // `RecordStore.addRun` returns `Promise<Run>`; `RecordStoreLike.addRun`
    // expects `Promise<void>` (the return is ignored by consumers). The cast
    // is safe; this test drives the REAL in-memory record store (the service
    // would use JSONL here).
    const record = createInMemoryRecordStore() as unknown as RecordStoreLike;

    // 2. Construct the dsh adapter, passing the record store through
    //    `opts.recordStore`. `transcriptDir` is a retained (retired-for-
    //    durability) config surface — post-Task 7 it must not receive a
    //    per-session mirror file.
    const adapter = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(),
      transcriptDir: dir,
    });

    await adapter.init({
      binding: { runtime: "dsh", config: {} },
      recordStore: record,
    });

    // 3. Drive one user turn → an assistant reply → the run settles (prepare +
    //    settle both flow through the record store now).
    const deltas = await collect(adapter.run(session(), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ]));
    assert.ok(
      deltas.some((d) => d.type === "session-status" && d.status === "idle"),
      "the run settles idle (settle persists through the record store)",
    );

    // 4. DURABLE ROUND-TRIP: the full transcript is in the RECORD STORE, keyed
    //    by the stable Session id.
    const loaded = await record.loadSessionTranscript?.("sess-1");
    assert.ok(loaded, "the record store holds the session transcript after settle");
    const messages = loaded?.messages as unknown[] | undefined;
    assert.ok(Array.isArray(messages) && messages.length >= 2, "the record's transcript carries the user + assistant exchange");

    // 5. REGRESSION GUARD: the adapter no longer writes an ephemeral
    //    TranscriptMirror `*.json` for the session under the transcript dir.
    const entries = await readdir(dir);
    assert.deepEqual(
      entries.filter((name) => name.endsWith(".json")),
      [],
      "no TranscriptMirror *.json file is written to the transcript dir",
    );

    // The end-to-end restart story: a NEW adapter instance over the SAME record
    // store restores the transcript from the record (its `prepare` read), never
    // from a mirror file on disk.
    const restarted = new DshRuntimeAdapter({ createClient: () => new FakeDshClient() });
    await restarted.init({ binding: { runtime: "dsh", config: {} }, recordStore: record });
    const probe = await collect(restarted.run(session(), []));
    const reconcile = probe.find((d) => d.type === "reconcile") as
      | { messages: { id: string }[] }
      | undefined;
    assert.ok(reconcile, "the restarted adapter's probe reconciles history");
    assert.deepEqual(
      reconcile?.messages.map((m) => m.id),
      ["u1", "am1"],
      "cold start restores the full transcript from the RECORD, not the mirror",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
