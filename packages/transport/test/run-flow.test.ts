import { test } from "node:test";
import assert from "node:assert/strict";
import { RunFlow } from "../src/run-flow.js";
import type { Message, StateDelta } from "../src/types.js";

async function drain(flow: RunFlow): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const d of flow.iterate()) out.push(d);
  return out;
}

test("queued deltas are enqueue-time snapshots — later mutations never leak in", async () => {
  const flow = new RunFlow();
  // add-message carries the LIVE message object that becomes the canonical row;
  // later folds mutate that very object's parts array in place.
  const live: Message = { id: "r1", role: "assistant", parts: [] };
  flow.push({ type: "add-message", message: live });
  live.parts.push({ type: "reasoning", text: "think" });
  flow.push({ type: "add-part", messageId: "r1", part: { type: "reasoning", text: "think" } });
  flow.end();

  const drained = await drain(flow);
  assert.equal(drained.length, 2);
  assert.deepEqual(drained[0], {
    type: "add-message",
    message: { id: "r1", role: "assistant", parts: [] },
  });
  assert.deepEqual(drained[1], {
    type: "add-part",
    messageId: "r1",
    part: { type: "reasoning", text: "think" },
  });
});

test("iterate drains queued deltas, wakes on later pushes, and returns after end", async () => {
  const flow = new RunFlow();
  flow.push({ type: "session-status", status: "running" });
  const it = flow.iterate();
  assert.deepEqual(await it.next(), { value: { type: "session-status", status: "running" }, done: false });
  // The next next() suspends until a push (or end) arrives.
  const pending = it.next();
  flow.push({ type: "session-status", status: "idle" });
  assert.deepEqual(await pending, { value: { type: "session-status", status: "idle" }, done: false });
  flow.end();
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test("end keeps draining queued deltas before terminating", async () => {
  const flow = new RunFlow();
  flow.push({ type: "session-status", status: "running" });
  flow.end();
  flow.push({ type: "session-status", status: "idle" });
  const drained = await drain(flow);
  assert.equal(drained.length, 2);
});
