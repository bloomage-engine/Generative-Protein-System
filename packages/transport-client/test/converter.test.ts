import { test } from "node:test";
import assert from "node:assert/strict";
import { partToContent, pendingUserMessages } from "../src/converter.js";
import type { AssistantTransportCommand } from "@assistant-ui/react";
import type { Message, MessagePart } from "@gps/transport";

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

test("artifact part becomes a file chip (rendered by the app's File component)", () => {
  const part: MessagePart = {
    type: "artifact",
    artifactId: "a1",
    name: "plot.png",
    kind: "image",
  };
  assert.deepEqual(partToContent(part), {
    type: "file",
    filename: "plot.png",
    mimeType: "application/octet-stream",
    data: "a1",
    sourceType: "id",
  });
});

test("file part becomes a chip carrying its workspace path", () => {
  const part: MessagePart = {
    type: "file",
    path: "analysis/plot.png",
    name: "plot.png",
    mime: "image/png",
    size: 12,
    source: "workspace",
  };
  assert.deepEqual(partToContent(part), {
    type: "file",
    filename: "plot.png",
    mimeType: "image/png",
    data: "analysis/plot.png",
    sourceType: "id",
  });
});

// -- pendingUserMessages ----------------------------------------------------

function send(text: string, extra: Partial<{ sourceId: string | null }> = {}): AssistantTransportCommand {
  return {
    type: "add-message",
    message: { role: "user", parts: [{ type: "text", text }] },
    parentId: null,
    sourceId: extra.sourceId ?? null,
  };
}

function userMessage(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

test("pending user messages not in the state become optimistic stand-ins", () => {
  const out = pendingUserMessages([], [send("hello there")]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.role, "user");
  assert.deepEqual(out[0]!.parts, [{ type: "text", text: "hello there" }]);
  assert.match(out[0]!.id, /^pending-/);
});

test("a pending message already echoed in the state is deduped out", () => {
  const out = pendingUserMessages([userMessage("u1", "hello there")], [send("hello there")]);
  assert.equal(out.length, 0);
});

test("the echo's server-minted id does not block the dedup (text-based)", () => {
  const out = pendingUserMessages([userMessage("msg-123", "hello there")], [send("hello there")]);
  assert.equal(out.length, 0);
});

test("mention directives are stripped on both sides before the dedup", () => {
  const sent = "see :file[plot.png]{name=analysis/plot.png} for the curve";
  const echoed = "see  for the curve".replace(/[ \t]{2,}/g, " ").trim();
  assert.equal(pendingUserMessages([userMessage("u1", echoed)], [send(sent)]).length, 0);
  assert.equal(pendingUserMessages([], [send(sent)]).length, 1);
});

test("only user add-message commands are carried; assistant and non-message commands are skipped", () => {
  const commands: AssistantTransportCommand[] = [
    { type: "add-message", message: { role: "assistant", parts: [{ type: "text", text: "x" }] }, parentId: null, sourceId: null },
    send("user send"),
  ];
  const out = pendingUserMessages([], commands);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.parts[0]!.type, "text");
});

test("image-only sends carry no parts (the domain union has no image part)", () => {
  const out = pendingUserMessages([], [
    {
      type: "add-message",
      message: { role: "user", parts: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
      parentId: null,
      sourceId: null,
    },
  ]);
  assert.equal(out.length, 0);
});

test("the stand-in id is stable across calls for the same send", () => {
  const a = pendingUserMessages([], [send("same text")]);
  const b = pendingUserMessages([], [send("same text")]);
  assert.equal(a[0]!.id, b[0]!.id);
});

test("a sourceId wins as the stand-in id when the runtime carries one", () => {
  const out = pendingUserMessages([], [send("hi", { sourceId: "src-9" })]);
  assert.equal(out[0]!.id, "pending-src-9");
});
