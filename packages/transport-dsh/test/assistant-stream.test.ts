import { test } from "node:test";
import assert from "node:assert/strict";
import type { StateDelta } from "@science-studio/transport";
import { LiveAssistantMessage } from "../src/assistant-stream.js";

function collect(): { emit: (delta: StateDelta) => void; deltas: StateDelta[] } {
  const deltas: StateDelta[] = [];
  return { emit: (delta) => void deltas.push(delta), deltas };
}

test("begin creates an empty row and reset clears its parts", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.begin();
  live.reset();
  assert.deepEqual(deltas, [
    { type: "add-message", message: { id: "s:1:1", role: "assistant", parts: [] } },
    { type: "update-message", messageId: "s:1:1", patch: { parts: [] } },
  ]);
});

test("a reasoning block streams via stream-reasoning, a text block via stream-text", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "reasoning" });
  live.accept({ type: "reasoning-delta", index: 0, text: "th" });
  live.accept({ type: "reasoning-delta", index: 0, text: "ink" });
  live.accept({ type: "block-end", index: 0 });
  live.accept({ type: "block-start", index: 1, blockType: "text" });
  live.accept({ type: "text-delta", index: 1, text: "hi" });
  assert.deepEqual(deltas, [
    { type: "stream-reasoning", messageId: "s:1:1", text: "th" },
    { type: "stream-reasoning", messageId: "s:1:1", text: "ink" },
    { type: "stream-text", messageId: "s:1:1", text: "hi" },
  ]);
});

test("a tool-call streams: the first delta adds the part, later deltas grow its args", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "tool-call" });
  live.accept({ type: "tool-call-delta", index: 0, id: "tc-1", name: "fs.read", argumentsDelta: '{"pa' });
  live.accept({ type: "tool-call-delta", index: 0, id: "tc-1", argumentsDelta: 'th":"a"}' });
  live.accept({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: '{"path":"a"}' },
  });
  assert.deepEqual(deltas, [
    {
      type: "add-part",
      messageId: "s:1:1",
      part: { type: "tool-call", id: "tc-1", name: "fs.read", args: '{"pa' },
    },
    {
      type: "update-message",
      messageId: "s:1:1",
      patch: {
        parts: [{ type: "tool-call", id: "tc-1", name: "fs.read", args: '{"path":"a"}' }],
      },
    },
  ]);
});

test("a tool-call with no deltas still appears from its block-end", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "tool-call" });
  live.accept({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: '{"path":"a"}' },
  });
  assert.deepEqual(deltas, [
    {
      type: "add-part",
      messageId: "s:1:1",
      part: { type: "tool-call", id: "tc-1", name: "fs.read", args: '{"path":"a"}' },
    },
  ]);
});

test("block-end overrides accumulated tool-call args with the authoritative block", () => {
  // The deltas accumulated `{"path":` but the assembled block carries the whole
  // `{"path":"a"}` — so the finalize update must land even though the part
  // already exists.
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "block-start", index: 0, blockType: "tool-call" });
  live.accept({ type: "tool-call-delta", index: 0, id: "tc-1", name: "fs.read", argumentsDelta: '{"path":' });
  live.accept({
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: "tc-1", name: "fs.read", arguments: '{"path":"a"}' },
  });
  assert.deepEqual(deltas, [
    {
      type: "add-part",
      messageId: "s:1:1",
      part: { type: "tool-call", id: "tc-1", name: "fs.read", args: '{"path":' },
    },
    {
      type: "update-message",
      messageId: "s:1:1",
      patch: { parts: [{ type: "tool-call", id: "tc-1", name: "fs.read", args: '{"path":"a"}' }] },
    },
  ]);
});

test("usage and finish chunks are ignored; a delta with no matching block is a no-op", () => {
  const { emit, deltas } = collect();
  const live = new LiveAssistantMessage("s:1:1", emit);
  live.accept({ type: "text-delta", index: 0, text: "stray" });
  live.accept({ type: "usage" });
  live.accept({ type: "finish" });
  assert.deepEqual(deltas, []);
});
