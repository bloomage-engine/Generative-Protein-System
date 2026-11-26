import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, MessagePart } from "@gps/transport";
import {
  attachHistoryToolResult,
  formatResultText,
  mergeToolResult,
  TOOL_RESULT_ROLES,
} from "../src/tool-result.js";
import { parseParts } from "../src/mapping.js";

function toolCall(id: string, extra: Partial<Extract<MessagePart, { type: "tool-call" }>> = {}): MessagePart {
  return { type: "tool-call", id, name: "read", args: "{}", ...extra };
}

test("TOOL_RESULT_ROLES recognizes the row-role spellings", () => {
  assert.equal(TOOL_RESULT_ROLES.has("toolresult"), true);
  assert.equal(TOOL_RESULT_ROLES.has("tool_result"), true);
  assert.equal(TOOL_RESULT_ROLES.has("tool-result"), true);
  assert.equal(TOOL_RESULT_ROLES.has("assistant"), false);
});

test("mergeToolResult attaches result text and isError to the matching part", () => {
  const parts: MessagePart[] = [toolCall("t1"), toolCall("t2")];
  assert.equal(mergeToolResult(parts, "t1", "the output", true), true);
  assert.deepEqual(parts[0], { type: "tool-call", id: "t1", name: "read", args: "{}", result: "the output", isError: true });
  // the sibling part is untouched
  assert.deepEqual(parts[1], toolCall("t2"));
});

test("mergeToolResult reports a miss so the caller keeps its fallback policy", () => {
  const parts: MessagePart[] = [toolCall("t1")];
  assert.equal(mergeToolResult(parts, "ghost", "orphan output", false), false);
  assert.equal(parts.length, 1);
});

test("an existing isError survives a non-error merge (errors are additive)", () => {
  const parts: MessagePart[] = [toolCall("t1", { isError: true })];
  assert.equal(mergeToolResult(parts, "t1", "recovered output", false), true);
  const part = parts[0] as Extract<MessagePart, { type: "tool-call" }>;
  assert.equal(part.isError, true);
  assert.equal(part.result, "recovered output");
});

test("attachHistoryToolResult merges a row into the LATEST message holding the part", () => {
  const messages: Message[] = [
    { id: "m1", role: "assistant", parts: [toolCall("t-old")] },
    { id: "m2", role: "assistant", parts: [toolCall("t-new")] },
  ];
  attachHistoryToolResult(messages, { role: "toolresult", toolCallId: "t-old", content: "done" });
  assert.deepEqual(messages[0]!.parts, [{ type: "tool-call", id: "t-old", name: "read", args: "{}", result: "done" }]);
  assert.deepEqual(messages[1]!.parts, [toolCall("t-new")]);
});

test("attachHistoryToolResult accepts snake_case ids and drops unmatched rows", () => {
  const messages: Message[] = [
    { id: "m1", role: "assistant", parts: [toolCall("t1")] },
  ];
  // snake_case id merges…
  attachHistoryToolResult(messages, { role: "tool_result", tool_call_id: "t1", result: [{ text: "ok" }], isError: true });
  assert.deepEqual(messages[0]!.parts, [
    { type: "tool-call", id: "t1", name: "read", args: "{}", result: "ok", isError: true },
  ]);
  // …an unmatched row changes nothing.
  attachHistoryToolResult(messages, { role: "toolresult", toolCallId: "ghost", content: "stale" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.parts.length, 1);
});

test("formatResultText flattens the gateway result shapes", () => {
  assert.equal(formatResultText("plain"), "plain");
  assert.equal(formatResultText([{ text: "a" }, { text: "b" }]), "a\nb");
  assert.equal(formatResultText({ content: "nested" }), "nested");
  assert.equal(formatResultText(42), "42");
});

test("parseParts merges a content-block tool-result into its tool-call (no duplicate part)", () => {
  const parts = parseParts({
    role: "assistant",
    content: [
      { type: "tool-call", id: "tc-1", name: "read", arguments: "{}" },
      { type: "tool-result", toolCallId: "tc-1", content: "the rows" },
    ],
  });
  assert.deepEqual(parts, [
    { type: "tool-call", id: "tc-1", name: "read", args: "{}", result: "the rows" },
  ]);
});

test("parseParts falls back to a standalone text part for an unmatched result block", () => {
  const parts = parseParts({
    role: "assistant",
    content: [
      { type: "tool-call", id: "tc-1", name: "read", arguments: "{}" },
      { type: "tool-result", toolCallId: "tc-ghost", content: "orphan" },
    ],
  });
  assert.deepEqual(parts, [
    { type: "tool-call", id: "tc-1", name: "read", args: "{}" },
    { type: "text", text: "orphan" },
  ]);
});

test("parseParts flags an error result on the matched part", () => {
  const parts = parseParts({
    role: "assistant",
    content: [
      { type: "tool-call", id: "tc-1", name: "read", arguments: "{}" },
      { type: "toolresult", tool_call_id: "tc-1", result: "boom", error: true },
    ],
  });
  assert.deepEqual(parts, [
    { type: "tool-call", id: "tc-1", name: "read", args: "{}", result: "boom", isError: true },
  ]);
});
