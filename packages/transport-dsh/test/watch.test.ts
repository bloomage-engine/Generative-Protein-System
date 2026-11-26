import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionState, StateDelta, WatchSnapshot } from "@gps/transport";
import { sessionState } from "@gps/contract-tests";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";
import { FakeRecordStore } from "./command-case.js";

function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

class FakeDshClient implements DshTurnClient {
  readonly sessionIds: string[] = [];
  constructor(private readonly script: (text: string) => SessionEvent[]) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async runTurn(
    sessionId: string,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    this.sessionIds.push(sessionId);
    for (const event of this.script(text)) onEvent(event);
  }
}

function reply(assistantId: string, text: string): SessionEvent[] {
  return [
    ev("turn/start", { turn: 1 }, 1),
    ev(
      "assistant/message",
      { turn: 1, step: 1, message: { id: assistantId, role: "assistant", content: [{ type: "text", text }], source: { kind: "model" } } },
      2,
    ),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
  ];
}

function session(): SessionState {
  return sessionState({ sessionId: "sess-1" });
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<void> {
  for await (const _ of iter) {
    /* drain */
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/** A no-op record store: these tests observe the watch seam, not persistence. */
const noRecordStore = { addRun: async () => {} };

test("a warm attach pushes a baseline, then one push per settled run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-watch-warm-"));
  let replyText = "Hello from dsh.";
  const client = new FakeDshClient(() => reply("am1", replyText));
  const adapter = new DshRuntimeAdapter({ createClient: () => client, transcriptDir: dir });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: noRecordStore });
    await collect(adapter.run(session(), [{ type: "add-message", message: { id: "u1", role: "user", content: "hi" } }]));

    // Warm attach: the baseline is pushed synchronously on subscribe.
    const frames: WatchSnapshot[] = [];
    const unsubscribe = adapter.subscribe("sess-1", (s) => frames.push(s));
    assert.equal(frames.length, 1, "a warm attach must baseline immediately");
    assert.equal(frames[0]!.status, "idle");

    // A later run's settle pushes a fresh snapshot to the standing watcher.
    replyText = "Second reply.";
    await collect(adapter.run(session(), [{ type: "add-message", message: { id: "u2", role: "user", content: "again" } }]));
    assert.equal(frames.length, 2, "a settled run must push to standing watchers");
    assert.ok(
      Object.values(frames[1]!.messages).some((m) => m.id === "am1" || m.parts.some((p) => p.type === "text" && p.text === "Second reply.")),
      "the settle push must carry the new turn's content",
    );

    unsubscribe();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cold attach (restart, transcript in the record) baselines asynchronously from the record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-watch-cold-"));
  // A restart shares the RECORD (docs/adr/0019), never an adapter-owned mirror.
  const store = new FakeRecordStore();
  try {
    // Generation 1 persists the transcript to the record.
    const adapter1 = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => reply("am1", "Hello from dsh.")),
      transcriptDir: dir,
    });
    await adapter1.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    await collect(adapter1.run(session(), [{ type: "add-message", message: { id: "u1", role: "user", content: "hi" } }]));

    // Generation 2: brand-new adapter over the same record, no in-memory
    // transcript — the watcher must still receive the baseline (from the
    // record), not hang.
    const adapter2 = new DshRuntimeAdapter({
      createClient: () => new FakeDshClient(() => []),
      transcriptDir: dir,
    });
    await adapter2.init({ binding: { runtime: "dsh", config: {} }, recordStore: store });
    const frames: WatchSnapshot[] = [];
    adapter2.subscribe("sess-1", (s) => frames.push(s));
    await tick(); // the record baseline is async
    assert.equal(frames.length, 1, "a cold attach with a record-backed transcript must baseline");
    const ids = Object.keys(frames[0]!.messages).sort();
    assert.deepEqual(ids, ["am1", "u1"], "the cold baseline must carry the persisted transcript");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a watcher attached before any content receives the first settled run (no silent hang)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-watch-first-"));
  const adapter = new DshRuntimeAdapter({
    createClient: () => new FakeDshClient(() => reply("am1", "First reply.")),
    transcriptDir: dir,
  });
  try {
    await adapter.init({ binding: { runtime: "dsh", config: {} }, recordStore: noRecordStore });
    const frames: WatchSnapshot[] = [];
    adapter.subscribe("sess-1", (s) => frames.push(s));
    await tick();
    assert.equal(frames.length, 0, "nothing on disk yet — no baseline to push");

    // Some client drives the first turn: its settle must reach the watcher.
    await collect(adapter.run(session(), [{ type: "add-message", message: { id: "u1", role: "user", content: "hi" } }]));
    assert.equal(frames.length, 1, "the first settle must wake a watcher that attached cold");
    assert.ok(Object.values(frames[0]!.messages).some((m) => m.id === "am1"), "the push carries the settled transcript");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
