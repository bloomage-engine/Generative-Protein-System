import { test } from "node:test";
import assert from "node:assert/strict";
import { foldState, sameConversation, sameMessages, type DeltaEffect, type FoldState } from "../src/fold.js";
import type { Message, MessagePart, SessionState, StateDelta } from "../src/types.js";

type Status = SessionState["status"];

function fresh(parts: MessagePart[] = []): Message {
  return { id: "m1", role: "assistant", parts };
}

function state(messages: Message[] = [], status: Status = "idle"): FoldState {
  return { status, messages };
}

function has(effects: DeltaEffect[], type: DeltaEffect["type"]): boolean {
  return effects.some((e) => e.type === type);
}

test("session-status sets status and reports a status effect", () => {
  const s = state();
  const effects = foldState(s, { type: "session-status", status: "running" });
  assert.deepEqual(effects, [{ type: "status", status: "running" }]);
  assert.equal(s.status, "running");
});

test("reconcile replaces the whole ordered message list and status", () => {
  const s = state([fresh([])], "running");
  const canonical: Message[] = [
    { id: "a", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "b", role: "assistant", parts: [{ type: "text", text: "yo" }] },
  ];
  const effects = foldState(s, { type: "reconcile", status: "idle", messages: canonical });
  assert.deepEqual(effects, [{ type: "messages-replaced" }]);
  assert.equal(s.status, "idle");
  assert.equal(s.messages, canonical); // list replaced wholesale, order preserved
  assert.equal(s.messages[1]!.id, "b");
});

test("add-message appends and reports message-added", () => {
  const s = state([fresh([])]);
  const msg: Message = { id: "m2", role: "user", parts: [{ type: "text", text: "hi" }] };
  const effects = foldState(s, { type: "add-message", message: msg });
  assert.deepEqual(effects, [{ type: "message-added", messageId: "m2" }]);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1], msg);
});

test("add-part appends a part to a known message; unknown id is dropped", () => {
  const s = state([fresh([])]);
  const part: MessagePart = { type: "text", text: "hello" };
  assert.deepEqual(foldState(s, { type: "add-part", messageId: "m1", part }), [
    { type: "parts-set", messageId: "m1" },
  ]);
  assert.equal(s.messages[0]!.parts.length, 1);

  const empty = state([fresh([])]);
  assert.deepEqual(foldState(empty, { type: "add-part", messageId: "ghost", part }), []);
  assert.equal(empty.messages[0]!.parts.length, 0);
});

test("append-text always creates a NEW text part (never grows the tail)", () => {
  const s = state([fresh([{ type: "text", text: "already" }])]);
  foldState(s, { type: "append-text", messageId: "m1", text: "+tail" });
  const parts = s.messages[0]!.parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1], { type: "text", text: "+tail" });
  assert.deepEqual(parts[0], { type: "text", text: "already" });
});

test("update-message patches parts and/or role; empty patch and unknown id are no-ops", () => {
  const s = state([fresh([])]);
  const newParts: MessagePart[] = [{ type: "reasoning", text: "think" }];
  const effects = foldState(s, {
    type: "update-message",
    messageId: "m1",
    patch: { parts: newParts, role: "user" },
  });
  assert.deepEqual(effects, [
    { type: "parts-set", messageId: "m1" },
    { type: "role-set", messageId: "m1", role: "user" },
  ]);
  assert.equal(s.messages[0]!.parts, newParts);
  assert.equal(s.messages[0]!.role, "user");

  const noop = state([fresh([])]);
  assert.deepEqual(foldState(noop, { type: "update-message", messageId: "m1", patch: {} }), []);
  const ghost = state([fresh([])]);
  assert.deepEqual(foldState(ghost, { type: "update-message", messageId: "ghost", patch: { parts: [] } }), []);
});

test("stream-text appends to a text tail", () => {
  const s = state([fresh([{ type: "text", text: "hel" }])]);
  const effects = foldState(s, { type: "stream-text", messageId: "m1", text: "lo" });
  assert.deepEqual(effects, [{ type: "text-appended", messageId: "m1", partIndex: 0, appended: "lo" }]);
  assert.deepEqual(s.messages[0]!.parts[0], { type: "text", text: "hello" });
});

test("stream-text with replace overwrites a text tail", () => {
  const s = state([fresh([{ type: "text", text: "stale" }])]);
  const effects = foldState(s, { type: "stream-text", messageId: "m1", text: "fresh", replace: true });
  assert.deepEqual(effects, [{ type: "text-set", messageId: "m1", partIndex: 0, text: "fresh" }]);
  assert.deepEqual(s.messages[0]!.parts[0], { type: "text", text: "fresh" });
});

test("stream-text on a non-text tail (or no tail) starts a new text part", () => {
  const reasoning = state([fresh([{ type: "reasoning", text: "think" }])]);
  const effects = foldState(reasoning, { type: "stream-text", messageId: "m1", text: "answer" });
  assert.deepEqual(effects, [{ type: "parts-set", messageId: "m1" }]);
  assert.deepEqual(reasoning.messages[0]!.parts, [
    { type: "reasoning", text: "think" },
    { type: "text", text: "answer" },
  ]);

  // replace:true with no text tail still starts a new part (pinned)
  const empty = state([fresh([])]);
  foldState(empty, { type: "stream-text", messageId: "m1", text: "x", replace: true });
  assert.deepEqual(empty.messages[0]!.parts, [{ type: "text", text: "x" }]);

  const ghost = state([fresh([])]);
  assert.deepEqual(foldState(ghost, { type: "stream-text", messageId: "ghost", text: "x" }), []);
});

test("stream-reasoning appends to a reasoning tail", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [{ type: "reasoning", text: "th" }] }]);
  const effects = foldState(s, { type: "stream-reasoning", messageId: "m1", text: "ink" });
  assert.deepEqual(effects, [{ type: "text-appended", messageId: "m1", partIndex: 0, appended: "ink" }]);
  assert.deepEqual(s.messages[0]!.parts, [{ type: "reasoning", text: "think" }]);
});

test("stream-reasoning with replace overwrites a reasoning tail", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [{ type: "reasoning", text: "old" }] }]);
  const effects = foldState(s, { type: "stream-reasoning", messageId: "m1", text: "fresh", replace: true });
  assert.deepEqual(effects, [{ type: "text-set", messageId: "m1", partIndex: 0, text: "fresh" }]);
  assert.deepEqual(s.messages[0]!.parts, [{ type: "reasoning", text: "fresh" }]);
});

test("stream-reasoning on a non-reasoning tail (or no tail) starts a new reasoning part", () => {
  const withText = state([{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] }]);
  const effects = foldState(withText, { type: "stream-reasoning", messageId: "m1", text: "why" });
  assert.deepEqual(effects, [{ type: "parts-set", messageId: "m1" }]);
  assert.deepEqual(withText.messages[0]!.parts, [
    { type: "text", text: "hi" },
    { type: "reasoning", text: "why" },
  ]);

  const empty = state([{ id: "m1", role: "assistant", parts: [] }]);
  foldState(empty, { type: "stream-reasoning", messageId: "m1", text: "x", replace: true });
  assert.deepEqual(empty.messages[0]!.parts, [{ type: "reasoning", text: "x" }]);
});

test("stream-reasoning on an unknown message is dropped", () => {
  const s = state([{ id: "m1", role: "assistant", parts: [] }]);
  assert.deepEqual(foldState(s, { type: "stream-reasoning", messageId: "ghost", text: "x" }), []);
});

test("set-part-text replaces text of a reasoning or text part in place", () => {
  const s = state([fresh([{ type: "reasoning", text: "old" }])]);
  const effects = foldState(s, { type: "set-part-text", messageId: "m1", partIndex: 0, text: "new" });
  assert.deepEqual(effects, [{ type: "text-set", messageId: "m1", partIndex: 0, text: "new" }]);
  assert.deepEqual(s.messages[0]!.parts, [{ type: "reasoning", text: "new" }]);
  // only one part: in-place update, no structural change
  assert.equal(s.messages[0]!.parts.length, 1);
});

test("set-part-text on an out-of-range index, a non-text part, or unknown message is dropped", () => {
  const tool = state([
    { id: "m1", role: "assistant", parts: [{ type: "tool-call", id: "t1", name: "ls", args: "{}" }] },
  ]);
  assert.deepEqual(foldState(tool, { type: "set-part-text", messageId: "m1", partIndex: 0, text: "x" }), []);
  assert.deepEqual(foldState(tool, { type: "set-part-text", messageId: "m1", partIndex: 5, text: "x" }), []);
  assert.deepEqual(foldState(tool, { type: "set-part-text", messageId: "ghost", partIndex: 0, text: "x" }), []);
  assert.deepEqual(tool.messages[0]!.parts[0], { type: "tool-call", id: "t1", name: "ls", args: "{}" });
});

test("approval-required surfaces an approval effect and mutates nothing", () => {
  const s = state([fresh([])]);
  const effects = foldState(s, { type: "approval-required", approvalId: "ap1", kind: "exec", summary: "run cmd" });
  assert.deepEqual(effects, [{ type: "approval", approvalId: "ap1", kind: "exec", summary: "run cmd" }]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.status, "idle");
});

test("fold mutates the passed state in place (array identity preserved on append)", () => {
  const msg = fresh([]);
  const s = state([msg]);
  const ref = s.messages;
  foldState(s, { type: "add-part", messageId: "m1", part: { type: "text", text: "a" } });
  foldState(s, { type: "stream-text", messageId: "m1", text: "b" });
  assert.equal(s.messages, ref);
  // stream-text grows the trailing text part ("a" + "b" → "ab")
  assert.deepEqual(s.messages[0]!.parts, [{ type: "text", text: "ab" }]);
});

test("sameMessages compares content AND order", () => {
  const a: Message = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };
  const b: Message = { id: "m2", role: "assistant", parts: [] };
  const b2: Message = { id: "m2", role: "assistant", parts: [] };
  assert.equal(sameMessages([a, b], [a, b2]), true);
  assert.equal(sameMessages([a, b], [b2, a]), false); // order is significant
  assert.equal(sameMessages([a, b], [a]), false);
  const changed: Message = { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] };
  assert.equal(sameMessages([a], [changed]), false);
  assert.equal(sameMessages([], []), true);
});

test("sameConversation ignores volatile ids and enrichment-only parts, but not role", () => {
  const local: Message = {
    id: "client-1",
    role: "user",
    parts: [{ type: "text", text: "hi" }, { type: "file", path: "a.txt", name: "a.txt", source: "workspace" }],
  };
  const history: Message = { id: "hist-0", role: "user", parts: [{ type: "text", text: "hi" }] };
  assert.equal(sameConversation([local], [history]), true, "ids ignored, file chip neutralized");

  // Role is part of the conversation: same parts, different role, NOT converged.
  const assistant: Message = { id: "x", role: "assistant", parts: [{ type: "text", text: "hi" }] };
  const user: Message = { id: "y", role: "user", parts: [{ type: "text", text: "hi" }] };
  assert.equal(sameConversation([assistant], [user]), false);

  // Conversational parts still count, and order is significant.
  const a: Message = { id: "a", role: "assistant", parts: [{ type: "text", text: "one" }] };
  const b: Message = { id: "b", role: "assistant", parts: [{ type: "text", text: "two" }] };
  assert.equal(sameConversation([a], [b]), false);
  assert.equal(sameConversation([a, b], [b, a]), false);
  assert.equal(sameConversation([a, b], [a]), false);

  // An artifact reference is a Run output the runtime history cannot see.
  const withArtifact: Message = {
    id: "c",
    role: "assistant",
    parts: [{ type: "text", text: "out" }, { type: "artifact", artifactId: "art-1", name: "f", kind: "figure" }],
  };
  const textOnly: Message = { id: "d", role: "assistant", parts: [{ type: "text", text: "out" }] };
  assert.equal(sameConversation([withArtifact], [textOnly]), true);
  assert.equal(sameConversation([], []), true);
});

test("repeated delta stream folds to the expected canonical transcript", () => {
  const s = state([]);
  const deltas: StateDelta[] = [
    { type: "session-status", status: "running" },
    { type: "add-message", message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } },
    { type: "add-message", message: { id: "r1", role: "assistant", parts: [] } },
    { type: "add-part", messageId: "r1", part: { type: "reasoning", text: "old" } },
    { type: "set-part-text", messageId: "r1", partIndex: 0, text: "new" },
    { type: "stream-text", messageId: "r1", text: "ok" },
    { type: "session-status", status: "idle" },
  ];
  for (const d of deltas) foldState(s, d);
  assert.equal(s.status, "idle");
  assert.deepEqual(s.messages, [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "r1", role: "assistant", parts: [{ type: "reasoning", text: "new" }, { type: "text", text: "ok" }] },
  ]);
});
