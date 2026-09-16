import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  createApplyContext,
  type ApplyContext,
  type RunControl,
  type SessionState,
  type SettleContext,
} from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";
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

function behavior(over: Partial<Parameters<typeof createDshBehavior>[0]> = {}) {
  return createDshBehavior({
    client: noopClient,
    mirror: null,
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
