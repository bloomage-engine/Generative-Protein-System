import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  foldState,
  type ApplyContext,
  type Message,
  type MessagePart,
  type RunControl,
  type SessionState,
  type StateDelta,
} from "@science-studio/transport";
import { createDshBehavior } from "../src/behavior.js";
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

function behavior() {
  return createDshBehavior({
    client: noopClient,
    mirror: null,
    harnessSessions: new Map(),
    provider: "p",
    model: "m",
    workspace: null,
  });
}

function freshState(): SessionState {
  return { sessionId: "sess-1", studyId: "study-1", agentId: "main", status: "idle", messages: [] };
}

/**
 * A minimal `ApplyContext` over a real `SessionState`, folding through the kit's
 * `foldState` so the assertions observe the transcript the real context builds.
 */
function makeCtx(state: SessionState, run: RunControl<SessionEvent> | null = null): ApplyContext<SessionEvent> {
  const emit = (delta: StateDelta): void => {
    foldState(state, delta);
  };
  return {
    sessionKey: "sess-1",
    state,
    emit,
    ensureMessage(id, role) {
      const existing = state.messages.find((m) => m.id === id);
      if (existing) return existing;
      const message: Message = { id, role, parts: [] };
      emit({ type: "add-message", message });
      return state.messages.find((m) => m.id === id)!;
    },
    mergeToolCall(update) {
      const message = state.messages.find((m) => m.id === update.messageId);
      if (!message) return;
      const index = message.parts.findIndex((p) => p.type === "tool-call" && p.id === update.toolCallId);
      if (index === -1) {
        if (update.name === undefined) return;
        const part: MessagePart = { type: "tool-call", id: update.toolCallId, name: update.name, args: update.args ?? "" };
        if (update.result !== undefined) (part as { result?: string }).result = update.result;
        if (update.isError) (part as { isError?: boolean }).isError = true;
        emit({ type: "add-part", messageId: message.id, part });
        return;
      }
      const next = [...message.parts];
      next[index] = {
        ...(message.parts[index] as Extract<MessagePart, { type: "tool-call" }>),
        ...(update.result !== undefined ? { result: update.result } : {}),
        ...(update.isError ? { isError: true } : {}),
      };
      emit({ type: "update-message", messageId: message.id, patch: { parts: next } });
    },
    reportRunId: () => {},
    targetRunId: null,
    run,
  };
}

function fakeRun(): { control: RunControl<SessionEvent>; notes: { status?: string; usage?: unknown }[] } {
  const notes: { status?: string; usage?: unknown }[] = [];
  const control: RunControl<SessionEvent> = {
    targetRunId: null,
    ingest: () => {},
    emit: () => {},
    note: (meta) => void notes.push(meta),
    settle: () => {},
    abort: () => {},
  };
  return { control, notes };
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
