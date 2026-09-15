/**
 * The transcript primitives `SessionRuntime` and `createApplyContext` share.
 *
 * These rules are asserted HERE because the module publishes them to adapters: a
 * behavior test drives them through `createApplyContext`, and one branch was
 * silently wrong for as long as it existed — a hand-rolled copy inside
 * `transport-dsh` merged a tool result but not the `args` a later event carries,
 * so that mapping was verified against a weaker rule than the one openclaw
 * ships. Nothing tested the rule itself, which is why the drift survived.
 *
 * The `SessionState` literal below is this package's OWN type (the kit defines
 * it), so it cannot drift the way an adapter's fixture can.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApplyContext } from "../src/apply-context.js";
import type { SessionState } from "../src/types.js";

const transcript = (): SessionState => ({
  sessionId: "session-1",
  projectId: "project-1",
  agentId: "main",
  status: "idle",
  messages: [],
});

/** The single tool-call part of `messageId`, as the transcript holds it. */
function toolPart(state: SessionState, messageId: string) {
  const parts = state.messages.find((m) => m.id === messageId)!.parts;
  assert.equal(parts.length, 1, "a tool-call lifecycle must never grow a second part");
  assert.equal(parts[0]!.type, "tool-call");
  return parts[0] as Extract<typeof parts[0], { type: "tool-call" }>;
}

test("a tool-call part is created on the first event and merged in place after", () => {
  const state = transcript();
  const ctx = createApplyContext(state);
  ctx.ensureMessage("m1", "assistant");

  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", name: "read", args: '{"p":"a"}' });
  assert.deepEqual(toolPart(state, "m1"), { type: "tool-call", id: "tc1", name: "read", args: '{"p":"a"}' });

  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", result: "file contents" });
  assert.equal(toolPart(state, "m1").result, "file contents");
  assert.equal(toolPart(state, "m1").args, '{"p":"a"}', "a later event must not rewrite args the part already carries");

  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", isError: true });
  assert.equal(toolPart(state, "m1").isError, true);
  assert.equal(toolPart(state, "m1").result, "file contents", "an error result keeps its text");
});

test("args arriving with a later event fill a part that had none", () => {
  const state = transcript();
  const ctx = createApplyContext(state);
  ctx.ensureMessage("m1", "assistant");

  // The start event names the tool but carries no arguments…
  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", name: "read" });
  assert.equal(toolPart(state, "m1").args, "");

  // …so the arguments a later event reports are the ones the transcript keeps.
  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", args: '{"p":"b"}' });
  assert.equal(toolPart(state, "m1").args, '{"p":"b"}');
  assert.equal(toolPart(state, "m1").name, "read", "a later event must not clear the tool's name");
});

test("isError is only ever added", () => {
  const state = transcript();
  const ctx = createApplyContext(state);
  ctx.ensureMessage("m1", "assistant");

  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", name: "read", isError: true });
  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc1", result: "recovered" });
  assert.equal(toolPart(state, "m1").isError, true, "a later non-error merge must not clear the flag");
});

test("an event the transcript cannot place adds no part and no message", () => {
  const state = transcript();
  const ctx = createApplyContext(state);

  // No message to attach to.
  ctx.mergeToolCall({ messageId: "ghost", toolCallId: "tc1", name: "read", args: "{}" });
  assert.equal(state.messages.length, 0, "an unattachable event must not create a row");

  // A result for a tool id the transcript never saw, with no name to create it.
  ctx.ensureMessage("m1", "assistant");
  ctx.mergeToolCall({ messageId: "m1", toolCallId: "tc-unknown", result: "orphan" });
  assert.deepEqual(state.messages[0]!.parts, [], "an unmatched result is dropped, never appended as its own part");
});
