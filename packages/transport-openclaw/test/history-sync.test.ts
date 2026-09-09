import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@science-studio/transport";
import { decideHistorySync, parseHistoryRows, type HistorySyncDecision } from "../src/history-sync.js";

function msg(role: "user" | "assistant", text: string, id: string): Message {
  return { id, role, parts: [{ type: "text", text }] };
}

/** A chat.history row: role + string content (or a raw shape for tool tests). */
function row(role: string, content: unknown, id?: string): Record<string, unknown> {
  return { role, content, ...(id !== undefined ? { id } : {}) };
}

function decide(input: {
  inFlight?: boolean;
  messages?: Message[];
  rows: unknown[];
}): HistorySyncDecision {
  return decideHistorySync({ inFlight: input.inFlight ?? false, messages: input.messages ?? [], rows: input.rows });
}

test("an empty transcript rebuilds from gateway rows", () => {
  const decision = decide({ rows: [row("user", "hi")] });
  assert.deepEqual(decision, {
    action: "rebuild",
    messages: [{ id: "hist-0", role: "user", parts: [{ type: "text", text: "hi" }] }],
  });
});

test("equal content keeps local ids (no churn when both sides converged)", () => {
  const local = [msg("user", "hi", "local-u"), msg("assistant", "yo", "local-a")];
  const decision = decide({ messages: local, rows: [row("user", "hi"), row("assistant", "yo")] });
  assert.deepEqual(decision, { action: "keep" });
});

test("a lagging gateway (content-prefix) keeps the local tail", () => {
  const local = [msg("user", "u1", "a"), msg("assistant", "a1", "b"), msg("user", "u2", "c"), msg("assistant", "a2", "d")];
  const decision = decide({
    messages: local,
    rows: [row("user", "u1"), row("assistant", "a1")],
  });
  assert.deepEqual(decision, { action: "keep" });
});

test("gateway rows beyond the transcript rebuild (remote user turn arrived)", () => {
  const local = [msg("user", "u1", "a"), msg("assistant", "a1", "b")];
  const decision = decide({
    messages: local,
    rows: [row("user", "remote-u"), row("user", "u1"), row("assistant", "a1")],
  });
  assert.deepEqual(decision.action, "rebuild");
  if (decision.action === "rebuild") {
    assert.equal(decision.messages.length, 3);
    assert.equal(decision.messages[0]!.parts[0]!.type, "text");
    assert.equal((decision.messages[0]!.parts[0] as { text: string }).text, "remote-u");
  }
});

test("same length but different content rebuilds (gateway wins)", () => {
  const local = [msg("user", "hi", "a"), msg("assistant", "yo", "b")];
  const decision = decide({
    messages: local,
    rows: [row("user", "hi-edited"), row("assistant", "yo")],
  });
  assert.deepEqual(decision.action, "rebuild");
});

test("an emptied gateway history resets a >=2-message transcript", () => {
  const local = [msg("user", "u1", "a"), msg("assistant", "a1", "b")];
  assert.deepEqual(decide({ messages: local, rows: [] }), { action: "reset" });
});

test("an empty gateway history spares a lone never-persisted message", () => {
  const local = [msg("user", "u1", "a")];
  assert.deepEqual(decide({ messages: local, rows: [] }), { action: "keep" });
});

test("an in-flight run is never touched, whatever the gateway says", () => {
  const local = [msg("user", "u1", "a"), msg("assistant", "partial", "b")];
  assert.deepEqual(decide({ inFlight: true, messages: local, rows: [] }), { action: "keep" });
  assert.deepEqual(decide({ inFlight: true, messages: local, rows: [row("user", "more")] }), {
    action: "keep",
  });
});

test("parseHistoryRows drops system rows and merges tool-result rows in order", () => {
  const messages = parseHistoryRows([
    row("system", "reset"),
    {
      role: "assistant",
      id: "a1",
      content: [{ type: "tool-call", id: "tc-1", name: "read", arguments: "{}" }],
    },
    { role: "toolresult", toolCallId: "tc-1", content: "the output" },
    row("user", "follow-up", "u2"),
  ]);
  assert.deepEqual(messages, [
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-call", id: "tc-1", name: "read", args: "{}", result: "the output" }],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "follow-up" }] },
  ]);
});
