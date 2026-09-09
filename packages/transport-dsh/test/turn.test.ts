import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@science-studio/transport";
import { runOutput, runStatus, Turn } from "../src/turn.js";

function text(role: "user" | "assistant", text: string, id: string): Message {
  return { id, role, parts: [{ type: "text", text }] };
}

test("runOutput projects the assistant TEXT that landed after the baseline", () => {
  const messages: Message[] = [
    text("user", "u1", "m0"),
    text("assistant", "a1", "m1"),
    { id: "m2", role: "assistant", parts: [{ type: "reasoning", text: "think" }] },
    { id: "m3", role: "assistant", parts: [{ type: "text", text: "a3a" }, { type: "text", text: "a3b" }] },
  ];
  // baseline 1: everything at/after index 1 belongs to the turn; reasoning and
  // tool text are excluded from the record's output (lossy by design).
  assert.equal(runOutput(messages, 1), "a1\na3a\na3b");
  assert.equal(runOutput(messages, 4), "");
});

test("runStatus maps a turn's terminal reason onto the Run status", () => {
  assert.equal(runStatus(undefined), "error");
  assert.equal(runStatus({ kind: "completed" } as never), "completed");
  assert.equal(runStatus({ kind: "error" } as never), "error");
  assert.equal(runStatus({ kind: "aborted" } as never), "aborted");
});

test("Turn.note collects the reason and usage an event reported", () => {
  const turn = new Turn({ userMessageId: "u1", input: "hi", startedAt: "t0" });
  turn.setBaseline(3);
  assert.equal(turn.baseline, 3);
  const usage = { inputTokens: 1 } as never;
  turn.note({ reason: { kind: "completed" } as never });
  turn.note({ usage });
  assert.equal(turn.reason?.kind, "completed");
  assert.equal(turn.usage, usage);
  turn.note({});
  assert.equal(turn.reason?.kind, "completed", "empty metas must not clear collected state");
});

test("Turn.end is idempotent and ends the flow once", async () => {
  const turn = new Turn({ userMessageId: "u1", input: "hi", startedAt: "t0" });
  assert.equal(turn.isEnded(), false);
  turn.end();
  turn.end(); // second end is a no-op
  assert.equal(turn.isEnded(), true);
  const drained: unknown[] = [];
  for await (const d of turn.flow.iterate()) drained.push(d);
  assert.deepEqual(drained, [], "an ended flow drains and terminates");
});
