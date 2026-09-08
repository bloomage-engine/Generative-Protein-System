import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialRuntimeState,
  fetchSessionSnapshot,
} from "../src/session-sync.js";
import type { Message } from "@science-studio/transport";

function sseResponse(body: string, ok = true): Response {
  const frames = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frames);
      controller.close();
    },
  });
  return new Response(stream, {
    status: ok ? 200 : 500,
    headers: { "content-type": "text/event-stream" },
  });
}

async function withFetchStub(stub: typeof fetch, fn: () => Promise<unknown>): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("folds a streamed snapshot (set + append-text ops) into RuntimeState", async () => {
  const frames =
    'data: {"type":"update-state","path":[],"operations":[' +
    '{"type":"set","path":["status"],"value":"idle"},' +
    '{"type":"set","path":["messages","u1"],"value":{"id":"u1","role":"user","parts":[{"type":"text","text":"he"}]}},' +
    '{"type":"set","path":["messages","a1"],"value":{"id":"a1","role":"assistant","parts":[{"type":"text","text":"yo"}]}},' +
    '{"type":"append-text","path":["messages","u1","parts","0","text"],"value":"llo"}' +
    "]}\n\n" +
    "data: [DONE]\n\n";

  const snap = (await withFetchStub(
    async () => sseResponse(frames),
    () => fetchSessionSnapshot("/api/transport", createInitialRuntimeState(), null),
  )) as Exclude<Awaited<ReturnType<typeof fetchSessionSnapshot>>, null>;

  assert.ok(snap);
  assert.equal(snap.status, "idle");
  const u1: Message | undefined = snap.messages["u1"];
  assert.ok(u1);
  // the append-text op grew the trailing text part (token-streaming wire contract)
  assert.deepEqual(u1.parts, [{ type: "text", text: "hello" }]);
  assert.deepEqual(snap.messages["a1"]?.parts, [{ type: "text", text: "yo" }]);
});

test("returns null when the endpoint answers non-2xx", async () => {
  const snap = await withFetchStub(
    async () => sseResponse("", false),
    () => fetchSessionSnapshot("/api/transport", createInitialRuntimeState(), null),
  );
  assert.equal(snap, null);
});

test("returns null when the stream never terminates with [DONE] (strict)", async () => {
  const frames = 'data: {"type":"update-state","path":[],"operations":[]}\n\n';
  const snap = await withFetchStub(
    async () => sseResponse(frames),
    () => fetchSessionSnapshot("/api/transport", createInitialRuntimeState(), null),
  );
  assert.equal(snap, null);
});
