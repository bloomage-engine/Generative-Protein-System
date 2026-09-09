import { test } from "node:test";
import assert from "node:assert/strict";
import { RunFlow, Transcript } from "../src/transcript.js";
import type { Message, SessionState, StateDelta } from "../src/types.js";

function session(): SessionState {
  return { sessionId: "s1", studyId: "study-1", agentId: "main", status: "idle", messages: [] };
}

async function drain(flow: RunFlow): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const d of flow.iterate()) out.push(d);
  return out;
}

test("constructor owns a copy of the initial state (no aliasing either way)", () => {
  const initial = session();
  const t = new Transcript("s1", initial);
  // Mutating the caller's object after construction must not reach the transcript…
  initial.status = "running";
  initial.messages.push({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
  assert.equal(t.state.status, "idle");
  assert.deepEqual(t.state.messages, []);
  // …and later transcript folds must not reach the caller's object.
  t.emit({ type: "add-message", message: { id: "m1", role: "assistant", parts: [] } });
  assert.equal(initial.messages.length, 1);
  assert.equal(t.state.messages.length, 1);
});

test("emit folds into the canonical state AND pushes to the attached flow", async () => {
  const t = new Transcript("s1", session());
  const flow = new RunFlow();
  t.attachFlow(flow);
  t.emit({ type: "add-message", message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } });
  t.emit({ type: "session-status", status: "running" });
  t.emit({ type: "session-status", status: "idle" });
  flow.end();
  const drained = await drain(flow);
  assert.equal(drained.length, 3);
  assert.deepEqual(drained[0], {
    type: "add-message",
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });
  assert.equal(t.state.status, "idle");
  assert.equal(t.state.messages.length, 1);
});

test("emit without an attached flow still folds (delta arriving between runs)", () => {
  const t = new Transcript("s1", session());
  t.emit({ type: "add-message", message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } });
  t.emit({ type: "session-status", status: "error" });
  assert.equal(t.state.messages.length, 1);
  assert.equal(t.state.status, "error");
  assert.equal(t.hasActiveFlow(), false);
});

test("attachFlow/detachFlow track a single in-flight flow", () => {
  const t = new Transcript("s1", session());
  const a = new RunFlow();
  const b = new RunFlow();
  t.attachFlow(a);
  assert.equal(t.hasActiveFlow(), true);
  t.attachFlow(b); // a later attach wins — one flow per run()
  t.detachFlow(a); // detaching a stale flow must not clear b
  assert.equal(t.hasActiveFlow(), true);
  t.detachFlow(b);
  assert.equal(t.hasActiveFlow(), false);
});

test("queued deltas are enqueue-time snapshots — later folds never leak in", async () => {
  const t = new Transcript("s1", session());
  const flow = new RunFlow();
  t.attachFlow(flow);

  // add-message carries the LIVE message object that becomes the canonical row;
  // later folds mutate that very object's parts array in place.
  const live: Message = { id: "r1", role: "assistant", parts: [] };
  t.emit({ type: "add-message", message: live });
  t.emit({ type: "add-part", messageId: "r1", part: { type: "reasoning", text: "think" } });
  t.emit({ type: "stream-text", messageId: "r1", text: "answer" });
  flow.end();

  const drained = await drain(flow);
  assert.equal(drained.length, 3);
  // The add-message snapshot was taken at enqueue: parts are still empty.
  assert.deepEqual(drained[0], {
    type: "add-message",
    message: { id: "r1", role: "assistant", parts: [] },
  });
  assert.deepEqual(drained[1], { type: "add-part", messageId: "r1", part: { type: "reasoning", text: "think" } });
  assert.deepEqual(drained[2], { type: "stream-text", messageId: "r1", text: "answer" });
  // …while the canonical state has the fully grown parts.
  assert.equal(t.state.messages[0]!.parts.length, 2);
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

test("snapshot deep-copies messages — later folds and snapshot edits never cross", () => {
  const t = new Transcript("s1", session());
  t.emit({ type: "add-message", message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } });
  const snap = t.snapshot();
  assert.equal(snap.type, "reconcile");
  assert.equal(t.state.status, "idle");
  if (snap.type !== "reconcile") return;
  assert.equal(snap.messages.length, 1);
  // Editing the snapshot payload must not touch the canonical state.
  (snap.messages[0]!.parts[0] as { text: string }).text = "edited";
  assert.equal((t.state.messages[0]!.parts[0] as { text: string }).text, "hi");
  // A later canonical fold must not reach an earlier snapshot.
  const earlier = t.snapshot();
  t.emit({ type: "session-status", status: "running" });
  if (earlier.type === "reconcile") assert.equal(earlier.status, "idle");
});

test("RunFlow.targetRunId defaults to null and is settable (run filtering)", () => {
  const flow = new RunFlow();
  assert.equal(flow.targetRunId, null);
  flow.targetRunId = "run-1";
  assert.equal(flow.targetRunId, "run-1");
});
