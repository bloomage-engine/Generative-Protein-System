import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  createApplyContext,
  type ApplyContext,
  type RunControl,
  type SessionState,
  type SettleContext,
  type StateDelta,
} from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";
import { createDshBehavior } from "../src/behavior.js";
import type { AssistantStreamFrame } from "../src/assistant-stream.js";
import type { DshTurnClient } from "../src/client.js";

/** Build a wire-shaped SessionEvent; shapes are cast (we drive the mapping, not dsh). */
function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

const noopClient: DshTurnClient = {
  start: async () => {},
  close: async () => {},
  runTurn: async () => {},
};

function behavior(over: Partial<Parameters<typeof createDshBehavior>[0]> = {}) {
  return createDshBehavior({
    client: noopClient,
    recordStore: null,
    harnessSessions: new Map(),
    profile: "sdk",
    provider: "p",
    model: "m",
    cwd: "/workspace",
    workspace: null,
    // No harness here: these tests drive the event→delta mapping.
    harnessCommands: { list: async () => [], execute: async () => ({ status: "unknown" }) },
    commandCatalog: async () => [],
    ...over,
  });
}

function freshState(): SessionState {
  return sessionState({ sessionId: "sess-1" });
}

/**
 * A context over a transcript the test owns — the KIT's own primitives, not a
 * copy of them. The copy had drifted (it merged a tool result but not the later
 * `args`), so the mapping below was asserted against a weaker rule than the one
 * that ships; `createApplyContext` is the same code `SessionRuntime` runs.
 */
function makeCtx(state: SessionState, run: RunControl<SessionEvent> | null = null): ApplyContext<SessionEvent> {
  return createApplyContext<SessionEvent>(state, { sessionKey: "sess-1", run });
}

function fakeRun(): {
  control: RunControl<SessionEvent>;
  notes: { status?: string; usage?: unknown }[];
  deltas: StateDelta[];
} {
  const notes: { status?: string; usage?: unknown }[] = [];
  const deltas: StateDelta[] = [];
  const control: RunControl<SessionEvent> = {
    targetRunId: null,
    ingest: () => {},
    emit: (delta) => void deltas.push(delta),
    note: (meta) => void notes.push(meta),
    settle: () => {},
    abort: () => {},
  };
  return { control, notes, deltas };
}

test("assistant/message maps content blocks to parts in order", () => {
  const state = freshState();
  const b = behavior();
  b.apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "think step" },
          { type: "text", text: "hello" },
          { type: "tool-call", id: "tc-1", name: "fs.read", arguments: '{"path":"a"}' },
        ],
        source: { kind: "model" },
      },
    }),
    makeCtx(state),
  );
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]!.id, "am1");
  assert.deepEqual(
    state.messages[0]!.parts.map((p) => p.type),
    ["reasoning", "text", "tool-call"],
  );
});

test("assistant/message does not duplicate an existing row and notes usage", () => {
  const state = freshState();
  const run = fakeRun();
  const b = behavior();
  const event = ev("assistant/message", {
    turn: 1,
    step: 1,
    message: { id: "am1", role: "assistant", content: [{ type: "text", text: "hi" }], source: { kind: "model" } },
    usage: { inputTokens: 1 },
  });
  b.apply?.(event, makeCtx(state, run.control));
  assert.equal(state.messages.length, 1);
  assert.deepEqual(run.notes, [{ usage: { inputTokens: 1 } }]);
});

test("tool/result attaches text into the matching tool-call part by callId", () => {
  const state = freshState();
  state.messages.push({
    id: "am1",
    role: "assistant",
    parts: [{ type: "tool-call", id: "tc-1", name: "read", args: "{}" }],
  });
  behavior().apply?.(
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tr-1",
        role: "user",
        content: [{ type: "tool-result", toolCallId: "tc-1", content: [{ type: "text", text: "file contents" }] }],
        source: { kind: "tool", callId: "tc-1" },
      },
    }),
    makeCtx(state),
  );
  const part = state.messages[0]!.parts[0]! as { result?: string; isError?: boolean };
  assert.equal(part.result, "file contents");
  assert.equal(part.isError, undefined);
});

test("tool/result with an error flags isError and keeps the result text", () => {
  const state = freshState();
  state.messages.push({
    id: "am1",
    role: "assistant",
    parts: [{ type: "tool-call", id: "tc-1", name: "read", args: "{}" }],
  });
  behavior().apply?.(
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tr-1",
        role: "user",
        content: [{ type: "tool-result", toolCallId: "tc-1", content: [{ type: "text", text: "boom" }] }],
        source: { kind: "tool", callId: "tc-1" },
      },
      error: { name: "FsError", code: "EACCES" },
    }),
    makeCtx(state),
  );
  const part = state.messages[0]!.parts[0]! as { result?: string; isError?: boolean };
  assert.equal(part.result, "boom");
  assert.equal(part.isError, true);
});

test("turn lifecycle maps running -> idle/error and settles with the Run status", () => {
  const state = freshState();
  const b = behavior();
  assert.equal(b.apply?.(ev("turn/start", { turn: 1 }), makeCtx(state)), undefined);
  assert.equal(state.status, "running");
  assert.deepEqual(b.apply?.(ev("turn/end", { turn: 1, reason: { kind: "completed" } }), makeCtx(state)), {
    settled: { status: "completed" },
  });
  assert.equal(state.status, "idle");

  state.status = "idle";
  assert.deepEqual(
    b.apply?.(
      ev("turn/end", { turn: 2, reason: { kind: "error", error: { message: "llm down", code: "UNKNOWN" } } }),
      makeCtx(state),
    ),
    { settled: { status: "error" } },
  );
  assert.equal(state.status, "error");

  state.status = "idle";
  b.apply?.(ev("turn/end", { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } }), makeCtx(state));
  assert.equal(state.status, "idle");
});

test("events with no seam rendering add no rows", () => {
  const state = freshState();
  const b = behavior();
  const ctx = makeCtx(state);
  b.apply?.(ev("user/message", { id: "um", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }), ctx);
  b.apply?.(
    ev("system/message", { turn: 1, step: 1, message: { id: "sm", role: "system", content: [], source: { kind: "plugin", plugin: "x" } } }),
    ctx,
  );
  b.apply?.(ev("step/start", { turn: 1, step: 1 }), ctx);
  assert.equal(state.messages.length, 0);
});

test("a command/done outside a cold command prompt adds no row", () => {
  // The WARM path answers with the bridge's own returned text, and the
  // harness's registry logs the same command into the session (its
  // `command/run`/`command/done` events reach us as ordinary session events).
  // Rendering them as well would double the reply row.
  const state = freshState();
  const b = behavior();
  const ctx = makeCtx(state);
  b.apply?.(ev("command/run", { commandId: "c1", name: "compact", source: { kind: "user" } }), ctx);
  b.apply?.(ev("command/done", { commandId: "c1", kind: "success", text: "Condensed 12 items" }), ctx);
  assert.equal(state.messages.length, 0);
});

function settleCtx(
  state: SessionState,
  directive: { status?: "completed" | "error"; usage?: unknown } = {},
): SettleContext {
  return {
    sessionKey: "sess-1",
    state,
    inRun: true,
    runId: "run-1",
    userMessageId: "u1",
    input: "q",
    baseline: 0,
    directive,
    startedAt: "2026-01-01T00:00:00.000Z",
    replaceMessages: () => {},
    resetSession: () => {},
    notify: () => {},
  };
}

test("request/context records provider/model/contextWindow on the projected Run", () => {
  const state = freshState();
  const b = behavior();
  b.apply?.(
    ev("request/context", { provider: "prov", model: "mod", contextWindow: 128000 }),
    makeCtx(state),
  );
  const spec = b.projectRun!(settleCtx(state, { usage: { inputTokens: 10, outputTokens: 5 } }));
  assert.equal(spec?.parameters?.provider, "prov");
  assert.equal(spec?.parameters?.model, "mod");
  assert.equal(spec?.parameters?.contextWindow, 128000);
  assert.deepEqual(spec?.parameters?.usage, { inputTokens: 10, outputTokens: 5 });
});

test("without request/context the Run keeps the configured route and no contextWindow", () => {
  const spec = behavior().projectRun!(settleCtx(freshState(), {}));
  assert.equal(spec?.parameters?.provider, "p");
  assert.equal(spec?.parameters?.model, "m");
  assert.equal(spec?.parameters?.contextWindow, undefined);
});

test("live frames create the row and stream reasoning, text and a tool call", () => {
  const state = freshState();
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1");
  assert.ok(harnessId, "dispatch mints and publishes the harness id before the turn runs");

  const frame = (next: AssistantStreamFrame): void =>
    b.ingestAssistantStream({ sessionId: harnessId, frame: next });
  // The real wire carries turn/step ONLY on the start frame; chunk/end carry
  // just the attemptId (the frames below are the captured shape).
  frame({ type: "start", turn: 1, step: 1, attemptId: "a1" });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "reasoning" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "reasoning-delta", index: 0, text: "think" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 1, blockType: "text" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 1, text: "hi" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 2, blockType: "tool-call" } });
  frame({
    type: "chunk",
    attemptId: "a1",
    chunk: {
      type: "block-end",
      index: 2,
      block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: "{}" },
    },
  });

  // The deltas STREAM to the client as they arrive — not only when the durable
  // assistant/message finalizes. This is the regression guard for the bug where
  // every chunk/end frame was dropped (no attemptId→row mapping existed).
  assert.ok(
    run.deltas.some((d) => d.type === "stream-reasoning" && d.text === "think"),
    "the reasoning delta streams live",
  );
  assert.ok(
    run.deltas.some((d) => d.type === "stream-text" && d.text === "hi"),
    "the text delta streams live",
  );

  const folded = createApplyContext<SessionEvent>(state);
  for (const delta of run.deltas) folded.emit(delta);

  assert.deepEqual(
    state.messages.map((m) => m.id),
    [`${harnessId}:1:1`],
  );
  assert.deepEqual(
    state.messages[0]!.parts.map((p) => p.type),
    ["reasoning", "text", "tool-call"],
  );
});

test("the durable assistant/message finalizes the live row and keeps its id", () => {
  const state = freshState();
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1")!;
  b.ingestAssistantStream({ sessionId: harnessId, frame: { type: "start", turn: 1, step: 1, attemptId: "a1" } });
  b.ingestAssistantStream({
    sessionId: harnessId,
    frame: { type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "text" } },
  });
  b.ingestAssistantStream({
    sessionId: harnessId,
    frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "hi" } },
  });
  const ctx = makeCtx(state);
  for (const delta of run.deltas) ctx.emit(delta);

  b.apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        source: { kind: "model" },
      },
    }),
    ctx,
  );
  assert.deepEqual(
    state.messages.map((m) => m.id),
    [`${harnessId}:1:1`],
    "the durable id is not adopted; the live row is finalized in place",
  );
  assert.deepEqual(state.messages[0]!.parts, [{ type: "text", text: "hi there" }]);
});

test("a durable assistant/message with no live frames keeps the durable id", () => {
  const state = freshState();
  behavior().apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "text", text: "hi" }], source: { kind: "model" } },
    }),
    makeCtx(state),
  );
  assert.deepEqual(state.messages.map((m) => m.id), ["am1"]);
});

test("a reset/restart mints a NEW harness id so the next conversation's rows do not collide (fails with a sessionKey-based key)", () => {
  // `/new` drops the conversation and a service restart starts a new child
  // generation; both restart the next turn at turn 1 step 1 on the SAME
  // Science Studio session key, and NEITHER clears the transcript (the record
  // cold-restores it; `/new` keeps earlier turns). So the live row id must be
  // scoped by the GENERATION-scoped harness id — a sessionKey-scoped key would
  // make run B's live frames hit run A's finalized entry and drop B entirely.
  const state = freshState();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });

  // Conversation A: live frames for turn 1 step 1, then its durable settlement.
  const runA = fakeRun();
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, runA.control);
  const harnessIdA = harnessSessions.get("sess-1")!;
  b.ingestAssistantStream({ sessionId: harnessIdA, frame: { type: "start", turn: 1, step: 1, attemptId: "a-old" } });
  b.ingestAssistantStream({
    sessionId: harnessIdA,
    frame: { type: "chunk", attemptId: "a-old", chunk: { type: "block-start", index: 0, blockType: "text" } },
  });
  b.ingestAssistantStream({
    sessionId: harnessIdA,
    frame: { type: "chunk", attemptId: "a-old", chunk: { type: "text-delta", index: 0, text: "old" } },
  });
  const ctx = makeCtx(state);
  for (const delta of runA.deltas) ctx.emit(delta);
  b.apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: { id: "amA", role: "assistant", content: [{ type: "text", text: "old answer" }], source: { kind: "model" } },
    }),
    ctx,
  );
  assert.deepEqual(state.messages.map((m) => m.id), [`${harnessIdA}:1:1`]);

  // A reset/restart: the session key stays, but the next turn mints a NEW
  // harness id (`/new` drops the mapping; a restart starts a new generation).
  harnessSessions.delete("sess-1");
  const runB = fakeRun();
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u2", content: "hi again" }] }, runB.control);
  const harnessIdB = harnessSessions.get("sess-1")!;
  assert.notEqual(harnessIdB, harnessIdA, "the reset mints a new harness session id");
  b.ingestAssistantStream({ sessionId: harnessIdB, frame: { type: "start", turn: 1, step: 1, attemptId: "a-new" } });
  b.ingestAssistantStream({
    sessionId: harnessIdB,
    frame: { type: "chunk", attemptId: "a-new", chunk: { type: "block-start", index: 0, blockType: "text" } },
  });
  b.ingestAssistantStream({
    sessionId: harnessIdB,
    frame: { type: "chunk", attemptId: "a-new", chunk: { type: "text-delta", index: 0, text: "new" } },
  });

  const addedIds = runB.deltas.flatMap((delta) => (delta.type === "add-message" ? [delta.message.id] : []));
  assert.deepEqual(
    addedIds,
    [`${harnessIdB}:1:1`],
    "the settled entry of the old generation does not suppress the new conversation's live row",
  );
  assert.ok(
    runB.deltas.some((delta) => delta.type === "stream-text" && delta.text === "new"),
    "the new run receives its frames",
  );

  // Both conversations fold through the SAME transcript — the reset does NOT
  // clear it. Two rows with distinct ids, each carrying its own conversation's
  // content; no duplicate id and no content written into A's row.
  for (const delta of runB.deltas) ctx.emit(delta);
  b.apply?.(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: { id: "amB", role: "assistant", content: [{ type: "text", text: "new answer" }], source: { kind: "model" } },
    }),
    ctx,
  );
  assert.deepEqual(
    state.messages.map((m) => m.id),
    [`${harnessIdA}:1:1`, `${harnessIdB}:1:1`],
    "both generations' rows survive with distinct ids",
  );
  assert.deepEqual(state.messages[0]!.parts, [{ type: "text", text: "old answer" }]);
  assert.deepEqual(state.messages[1]!.parts, [{ type: "text", text: "new answer" }]);
});

test("a retried attempt resets the same live row and streams again", () => {
  const state = freshState();
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1")!;
  const frame = (next: AssistantStreamFrame): void =>
    b.ingestAssistantStream({ sessionId: harnessId, frame: next });

  // The first attempt streams some content.
  frame({ type: "start", turn: 1, step: 1, attemptId: "a1" });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "text" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "first" } });

  // The attempt is retried on the SAME (turn, step): a second start RESETS the
  // row (clear its parts) rather than minting a second one.
  frame({ type: "start", turn: 1, step: 1, attemptId: "a2" });
  assert.ok(
    run.deltas.some(
      (d) => d.type === "update-message" && d.messageId === `${harnessId}:1:1` && d.patch.parts?.length === 0,
    ),
    "the retry resets the existing row",
  );
  frame({ type: "chunk", attemptId: "a2", chunk: { type: "block-start", index: 0, blockType: "text" } });
  frame({ type: "chunk", attemptId: "a2", chunk: { type: "text-delta", index: 0, text: "second" } });

  const ctx = makeCtx(state);
  for (const delta of run.deltas) ctx.emit(delta);
  assert.deepEqual(
    state.messages.map((m) => m.id),
    [`${harnessId}:1:1`],
    "the retry reuses the one row",
  );
  assert.deepEqual(state.messages[0]!.parts, [{ type: "text", text: "second" }]);
});

test("a late chunk after end is dropped", () => {
  const run = fakeRun();
  const harnessSessions = new Map<string, string>();
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);
  const harnessId = harnessSessions.get("sess-1")!;
  const frame = (next: AssistantStreamFrame): void =>
    b.ingestAssistantStream({ sessionId: harnessId, frame: next });

  frame({ type: "start", turn: 1, step: 1, attemptId: "a1" });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "block-start", index: 0, blockType: "text" } });
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "live" } });

  const beforeEnd = run.deltas.length;
  frame({ type: "end", attemptId: "a1", outcome: { kind: "committed", eventType: "assistant/message" } });
  assert.equal(run.deltas.length, beforeEnd, "end emits no delta");

  // The attempt binding is gone, so a further chunk cannot reach the row.
  frame({ type: "chunk", attemptId: "a1", chunk: { type: "text-delta", index: 0, text: "late" } });
  assert.equal(run.deltas.length, beforeEnd, "the late chunk is dropped");
  assert.ok(!run.deltas.some((d) => d.type === "stream-text" && d.text === "late"));
});

test("frames for an unknown session or with no active run are no-ops", () => {
  const run = fakeRun();
  const harnessSessions = new Map<string, string>([
    ["sess-1", "harness-1"],
    ["sess-2", "harness-2"],
  ]);
  const client: DshTurnClient = {
    start: async () => {},
    close: async () => {},
    runTurn: (_sessionId, _text, _onEvent) => new Promise<void>(() => {}),
  };
  const b = behavior({ client, harnessSessions });
  // Only sess-1 gets an active run.
  b.dispatch?.({ sessionKey: "sess-1", messages: [{ id: "u1", content: "hi" }] }, run.control);

  // A known harness id with NO active run, and an unknown/subagent session:
  // both are silently ignored, never thrown.
  assert.doesNotThrow(() =>
    b.ingestAssistantStream({ sessionId: "harness-2", frame: { type: "start", turn: 1, step: 1, attemptId: "a1" } }),
  );
  assert.doesNotThrow(() =>
    b.ingestAssistantStream({
      sessionId: "subagent:child",
      frame: { type: "start", turn: 1, step: 1, attemptId: "a1" },
    }),
  );
  assert.equal(run.deltas.length, 0);
});
