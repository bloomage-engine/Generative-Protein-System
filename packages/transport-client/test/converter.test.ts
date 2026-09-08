import { test } from "node:test";
import assert from "node:assert/strict";
import { partToContent } from "../src/converter.js";
import type { MessagePart } from "@science-studio/transport";

test("text part maps to a text content part", () => {
  const part: MessagePart = { type: "text", text: "hello" };
  assert.deepEqual(partToContent(part), { type: "text", text: "hello" });
});

test("reasoning part maps to a reasoning content part", () => {
  const part: MessagePart = { type: "reasoning", text: "hmm" };
  assert.deepEqual(partToContent(part), { type: "reasoning", text: "hmm" });
});

test("tool-call with JSON object args keeps parsed args AND the raw argsText", () => {
  const part: MessagePart = {
    type: "tool-call",
    id: "t1",
    name: "search",
    args: '{"q":"life"}',
  };
  assert.deepEqual(partToContent(part), {
    type: "tool-call",
    toolCallId: "t1",
    toolName: "search",
    args: { q: "life" },
    argsText: '{"q":"life"}',
  });
});

test("tool-call with non-object args falls back to empty args", () => {
  for (const args of ["not-json", "42", "[1,2]", "null", ""]) {
    const part: MessagePart = { type: "tool-call", id: "t1", name: "x", args };
    assert.deepEqual(partToContent(part).args, {}, `args=${JSON.stringify(args)}`);
    assert.equal(partToContent(part).argsText, args);
  }
});

test("tool-call with a result carries it; an error flag carries isError", () => {
  const withResult: MessagePart = {
    type: "tool-call",
    id: "t1",
    name: "x",
    args: "{}",
    result: "ok",
  };
  assert.equal(partToContent(withResult).result, "ok");

  const withError: MessagePart = {
    type: "tool-call",
    id: "t2",
    name: "x",
    args: "{}",
    isError: true,
  };
  assert.equal(partToContent(withError).isError, true);
  assert.equal(partToContent(withError).result, undefined);
});

test("artifact part degrades to a text placeholder", () => {
  const part: MessagePart = {
    type: "artifact",
    artifactId: "a1",
    name: "plot.png",
    kind: "image",
  };
  assert.deepEqual(partToContent(part), { type: "text", text: "[artifact: plot.png]" });
});
