import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore, type RecordStore } from "@gps/record";
import {
  type Message,
  type RecordStoreLike,
  type SessionState,
  type SettleContext,
  type TranscriptHandle,
} from "@gps/transport";
import { sessionState } from "@gps/contract-tests";
import { createDshBehavior } from "../src/behavior.js";
import type { DshTurnClient } from "../src/client.js";

/**
 * The 3 transcript touchpoints against the RECORD store (docs/adr/0019): the
 * direct regression for the "rich store is ephemeral, thin store is
 * authoritative" inversion — after a "restart", the record still holds the
 * transcript (the adapter-owned mirror did not), so `prepare` /
 * `beforePersist` / `watch.readBaseline` must read and write the record's own
 * `saveSessionTranscript` / `loadSessionTranscript` (Task 4's optional seam
 * methods), `?.`-guarded so a miswired non-record store no-ops.
 */

const noopClient: DshTurnClient = {
  start: async () => {},
  close: async () => {},
  runTurn: async () => {},
};

/**
 * The narrow seam view the dsh behavior sees: the full record wrapped into
 * the `RecordStoreLike` (the service's `toRecordStoreLike` does the same —
 * the record's `addRun` returns its row, the seam wants `Promise<void>`).
 */
function like(record: RecordStore): RecordStoreLike {
  return {
    addRun: async (run) => {
      await record.addRun(run);
    },
    saveSessionTranscript: (id, doc) => record.saveSessionTranscript(id, doc),
    loadSessionTranscript: (id) => record.loadSessionTranscript(id),
    upsertSubagent: (s) => record.upsertSubagent(s),
    loadSubagent: (id) => record.loadSubagent(id),
    listSubagents: (p) => record.listSubagents(p),
  };
}

function behavior(recordStore: RecordStoreLike | null) {
  return createDshBehavior({
    client: noopClient,
    recordStore,
    harnessSessions: new Map(),
    profile: "sdk",
    provider: "p",
    model: "m",
    cwd: "/workspace",
    workspace: null,
    // No harness here: these tests drive the record touchpoints.
    harnessCommands: {
      list: async () => [],
      execute: async () => ({ status: "unknown" }),
      interrupt: async () => {},
    },
    commandCatalog: async () => [],
  });
}

/**
 * The kit's `TranscriptHandle` over a transcript the test owns — only the
 * members the 3 hooks read (state / sessionKey / replaceMessages).
 */
function anyHandle(state: SessionState): TranscriptHandle {
  return {
    sessionKey: state.sessionId,
    state,
    replaceMessages: (messages, status) => {
      state.messages = [...messages];
      if (status !== undefined) state.status = status;
    },
    resetSession: () => {
      state.messages = [];
      state.status = "idle";
    },
    notify: () => {},
  };
}

function settleCtx(state: SessionState, sessionKey: string): SettleContext {
  return {
    sessionKey,
    state,
    inRun: true,
    runId: "run-1",
    userMessageId: "u1",
    input: "q",
    baseline: 0,
    directive: {},
    startedAt: "2026-01-01T00:00:00.000Z",
    replaceMessages: () => {},
    resetSession: () => {},
    notify: () => {},
  };
}

test("prepare seeds a COLD transcript from the record (the restart regression)", async () => {
  const record = createInMemoryRecordStore();
  const transcript: Message[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "am1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
  ];
  await record.saveSessionTranscript("sess-a", { v: 1, status: "idle", messages: transcript });

  const state = sessionState({ sessionId: "sess-a" });
  const b = behavior(like(record));
  await b.prepare?.(anyHandle(state));

  assert.equal(state.messages.length, 2, "the cold state is seeded from the record's saved transcript");
  assert.deepEqual(state.messages.map((m) => m.id), ["u1", "am1"]);
});

test("prepare leaves a warm transcript alone (cold-start only)", async () => {
  const record = createInMemoryRecordStore();
  await record.saveSessionTranscript("sess-a", {
    v: 1,
    status: "idle",
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "earlier" }] }],
  });

  const state = sessionState({ sessionId: "sess-a" });
  state.messages.push({ id: "local", role: "user", parts: [{ type: "text", text: "in flight" }] });
  await behavior(like(record)).prepare?.(anyHandle(state));

  assert.deepEqual(state.messages.map((m) => m.id), ["local"], "a non-empty transcript is never replaced");
});

test("prepare no-ops when the record holds nothing for this session", async () => {
  const record = createInMemoryRecordStore();
  const state = sessionState({ sessionId: "sess-empty" });
  await behavior(like(record)).prepare?.(anyHandle(state));
  assert.equal(state.messages.length, 0);
});

test("beforePersist saves the settled transcript to the record", async () => {
  const record = createInMemoryRecordStore();
  const state = sessionState({ sessionId: "sess-b" });
  state.messages.push({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
  state.messages.push({ id: "am1", role: "assistant", parts: [{ type: "text", text: "hello" }] });

  await behavior(like(record)).beforePersist?.(settleCtx(state, "sess-b"));

  const saved = await record.loadSessionTranscript("sess-b");
  assert.ok(saved, "the settled transcript is persisted in the record (survives a restart)");
  assert.equal(saved!.v, 1, "the saved doc carries the versioned envelope");
  assert.equal(saved!.status, "idle", "the saved doc carries the settled status");
  assert.deepEqual((saved!.messages as Message[]).map((m) => m.id), ["u1", "am1"]);
  // The record stores a CLONE: later mutations of the live state must not leak.
  state.messages.push({ id: "u2", role: "user", parts: [{ type: "text", text: "after" }] });
  assert.equal((await record.loadSessionTranscript("sess-b"))!.messages !== state.messages, true, "no aliasing");
});

test("watch.readBaseline serves the cold Session's baseline from the record", async () => {
  const record = createInMemoryRecordStore();
  await record.saveSessionTranscript("sess-c", {
    v: 1,
    status: "idle",
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "am1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ],
  });

  const baseline = await behavior(like(record)).watch?.readBaseline?.("sess-c");
  assert.ok(baseline, "a record-backed cold Session baselines (a watcher must not hang)");
  assert.equal(baseline!.status, "idle");
  assert.deepEqual(Object.keys(baseline!.messages).sort(), ["am1", "u1"], "the snapshot is keyed by message id");
  assert.ok(
    baseline!.messages["am1"]?.parts.some((p) => p.type === "text" && p.text === "hello"),
    "the baseline carries the saved content",
  );

  assert.equal(await behavior(like(record)).watch?.readBaseline?.("sess-unknown"), null, "an unknown session baselines null");
});

test("a non-record store (no transcript methods) no-ops instead of throwing", async () => {
  // Task 4 made the record methods OPTIONAL on the seam: the dsh call sites
  // `?.`-guard them, so a miswired `addRun`-only sink (the service's narrow
  // view) is a silent no-op, never a null-deref.
  const sink: RecordStoreLike = { addRun: async () => {} };
  const b = behavior(sink);
  const state = sessionState({ sessionId: "sess-d" });

  await b.prepare?.(anyHandle(state));
  assert.equal(state.messages.length, 0, "prepare no-ops");

  state.messages.push({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
  await b.beforePersist?.(settleCtx(state, "sess-d")); // a throw would fail the test

  const baseline = await b.watch?.readBaseline?.("sess-d");
  assert.equal(baseline, null, "readBaseline no-ops to null");
});
