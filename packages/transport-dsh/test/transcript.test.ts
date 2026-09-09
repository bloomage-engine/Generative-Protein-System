import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { DshTranscript } from "../src/transcript.js";

/** Build a wire-shaped SessionEvent; shapes are cast (we drive the mapping, not dsh). */
function ev(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: Date.now(), data } as unknown as SessionEvent;
}

const SESSION = { studyId: "study-1", agentId: "main" };

function textResultMessage(text: string): unknown {
  return {
    id: "tr-1",
    role: "user",
    content: [{ type: "tool-result", toolCallId: "tc-1", content: [{ type: "text", text }] }],
    source: { kind: "tool", callId: "tc-1" },
  };
}

test("assistant/message maps content blocks to parts in order", () => {
  const t = new DshTranscript("s1", SESSION);
  const meta = t.apply(
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
  );
  assert.equal(t.state.messages.length, 1);
  const msg = t.state.messages[0]!;
  assert.equal(msg.id, "am1");
  assert.equal(msg.role, "assistant");
  assert.deepEqual(
    msg.parts.map((p) => p.type),
    ["reasoning", "text", "tool-call"],
  );
  assert.equal(meta.reason, undefined);
});

test("tool/result attaches text into the matching tool-call part by callId", () => {
  const t = new DshTranscript("s1", SESSION);
  t.apply(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [{ type: "tool-call", id: "tc-1", name: "read", arguments: "{}" }],
        source: { kind: "model" },
      },
    }),
  );
  t.apply(ev("tool/result", { turn: 1, step: 1, message: textResultMessage("file contents") }));
  const part = t.state.messages[0]!.parts[0]!;
  assert.equal(part.type, "tool-call");
  assert.equal((part as { result?: string }).result, "file contents");
  assert.equal((part as { isError?: boolean }).isError, undefined);
});

test("tool/result with an error flags isError and keeps the result text", () => {
  const t = new DshTranscript("s1", SESSION);
  t.apply(
    ev("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [{ type: "tool-call", id: "tc-1", name: "read", arguments: "{}" }],
        source: { kind: "model" },
      },
    }),
  );
  t.apply(
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: textResultMessage("boom"),
      error: { name: "FsError", code: "EACCES" },
    }),
  );
  const part = t.state.messages[0]!.parts[0]! as { isError?: boolean; result?: string };
  assert.equal(part.isError, true);
  assert.equal(part.result, "boom");
});

test("turn lifecycle maps running -> idle/error by reason and reports the reason", () => {
  const t = new DshTranscript("s1", SESSION);
  assert.equal(t.apply(ev("turn/start", { turn: 1 })).reason, undefined);
  assert.equal(t.state.status, "running");
  const completed = t.apply(ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
  assert.equal(t.state.status, "idle");
  assert.equal(completed.reason?.kind, "completed");

  t.apply(ev("turn/start", { turn: 2 }));
  const errored = t.apply(
    ev("turn/end", { turn: 2, reason: { kind: "error", error: { message: "llm down", code: "UNKNOWN" } } }),
  );
  assert.equal(t.state.status, "error");
  assert.equal(errored.reason?.kind, "error");

  t.apply(ev("turn/start", { turn: 3 }));
  const aborted = t.apply(ev("turn/end", { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } }));
  assert.equal(t.state.status, "idle");
  assert.equal(aborted.reason?.kind, "aborted");
});

test("user/message and system/message events do not duplicate transcript rows", () => {
  const t = new DshTranscript("s1", SESSION);
  t.apply(
    ev("user/message", {
      id: "um-dsh",
      role: "user",
      content: [{ type: "text", text: "hi" }],
      source: { kind: "user" },
    }),
  );
  t.apply(
    ev("system/message", {
      turn: 1,
      step: 1,
      message: { id: "sm", role: "system", content: [], source: { kind: "plugin", plugin: "x" } },
    }),
  );
  t.apply(ev("step/start", { turn: 1, step: 1 }));
  assert.equal(t.state.messages.length, 0, "only surface-bearing events add rows");
});

test("restore() adopts a persisted mirror (cold start)", () => {
  const t = new DshTranscript("s1", SESSION);
  t.restore([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }], "idle");
  assert.equal(t.state.messages.length, 1);
  assert.equal(t.state.status, "idle");
  const snapshot = t.snapshot();
  assert.equal(snapshot.type, "reconcile");
  if (snapshot.type === "reconcile") {
    assert.equal(snapshot.messages[0]!.id, "u1");
  }
});
