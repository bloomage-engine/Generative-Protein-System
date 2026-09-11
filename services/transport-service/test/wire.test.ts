import { test } from "node:test";
import assert from "node:assert/strict";
import { foldState, RunFlow } from "@science-studio/transport";
import type { Message, SessionState, StateDelta } from "@science-studio/transport";
import { WireOpsBuilder, type WireOp } from "../src/wire.js";

/**
 * Regression coverage for the wire fold's STATE PRIVACY requirement.
 *
 * The adapter folds every delta onto its canonical transcript BEFORE the wire
 * mirror folds it (the shared `emit` folds FIRST, then pushes a snapshot into
 * the attached `RunFlow`), and payload-bearing deltas (add-message
 * / add-part / update-message) reference the adapter's LIVE message objects.
 * If the mirror adopted those references, its own fold would re-apply
 * mutations the adapter's fold already made to the shared objects — doubling
 * parts and taking different `stream-text` branches than the client will
 * (emitting `append-text` for a text part whose `parts-set` was never
 * streamed). The client accumulator then throws:
 *
 *   Error: Expected string at path [messages, <id>, parts, <N>, text]
 *
 * These tests replay the real pipeline (a shared canonical fold + RunFlow
 * feeding WireOpsBuilder, adapter running either ahead of or interleaved with
 * the wire drain) against a strict client accumulator with GorpStreamAccumulator's
 * exact semantics, and assert the stream is applicable and the client
 * converges to the transcript.
 */

const sessionKey = "agent:main:main";

/** The wire ops the real service writes: JSON-snapshotted at fold time. */
function snapshot(ops: WireOp[]): WireOp[] {
  return ops.map((op) => JSON.parse(JSON.stringify(op)) as WireOp);
}

/**
 * Faithful stand-in for the client-side GorpStreamAccumulator: `set` at a
 * path; `append-text` ONLY onto an existing string, otherwise it throws the
 * exact error the browser transport runtime reports.
 */
function applyClientOp(state: Record<string, unknown>, op: WireOp): Record<string, unknown> {
  const updatePath = (
    node: unknown,
    path: readonly string[],
    updater: (current: unknown) => unknown,
  ): unknown => {
    if (path.length === 0) return updater(node);
    node ??= {};
    if (typeof node !== "object") throw new Error(`Invalid path: [${path.join(", ")}]`);
    const [key, ...rest] = path as [string, ...(readonly string[])];
    if (Array.isArray(node)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || String(idx) !== key) {
        throw new Error(`Expected array index at [${path.join(", ")}]`);
      }
      if (idx < 0 || idx > node.length) throw new Error(`Insert array index out of bounds`);
      const next = [...node];
      next[idx] = updatePath(idx in next ? next[idx] : undefined, rest, updater);
      return next;
    }
    const next = { ...(node as Record<string, unknown>) };
    next[key] = updatePath(Object.hasOwn(next, key) ? next[key] : undefined, rest, updater);
    return next;
  };
  return (op.type === "set"
    ? updatePath(state, op.path, () => op.value)
    : updatePath(state, op.path, (current) => {
        if (typeof current !== "string") {
          throw new Error(`Expected string at path [${op.path.join(", ")}]`);
        }
        return current + op.value;
      })) as Record<string, unknown>;
}

function clientState(
  ops: WireOp[],
): { status: string; messages: Record<string, Message> } {
  let state: Record<string, unknown> = { status: "idle", messages: {} };
  for (const op of ops) state = applyClientOp(state, op);
  return JSON.parse(JSON.stringify(state)) as { status: string; messages: Record<string, Message> };
}

/**
 * The real transport pipeline for one run: a shared canonical fold (fold every
 * delta onto the canonical state, then push the SAME delta into a `RunFlow`)
 * feeding a `WireOpsBuilder` that drains the flow — the same fold-and-fan-out
 * the `SessionRuntime` performs. `drainPerEvent` mirrors the adapter running
 * ahead of the wire (false = all events folded before any drain) or interleaved
 * with it (true = each delta is wire-folded before the next lands, like the
 * service's for-await over the adapter stream).
 */
function makePipeline(drainPerEvent: boolean) {
  const state: SessionState = {
    sessionId: sessionKey,
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  };
  const flow = new RunFlow();
  const wire = new WireOpsBuilder({ status: "idle", messages: [] });
  const ops: WireOp[] = [];
  const iterator = flow.iterate();
  let exhausted = false;

  const drainOne = async (): Promise<void> => {
    const { value, done } = await iterator.next();
    if (done) {
      exhausted = true;
      return;
    }
    if (value) ops.push(...snapshot(wire.fold(value)));
  };

  return {
    state,
    ops,
    /** Fold one delta (and, when interleaving, wire-fold it right away). */
    async emit(delta: StateDelta): Promise<void> {
      foldState(state, delta);
      flow.push(delta);
      if (drainPerEvent) await drainOne();
    },
    /** End the run (the adapter ends the flow at the terminal event), then
     *  wire-fold whatever is still queued. */
    async finish(): Promise<void> {
      flow.end();
      while (!exhausted) await drainOne();
    },
    /** ensureAssistant: the SAME live message object enters both graphs. */
    async ensureAssistant(runId: string): Promise<void> {
      const msg: Message = { id: runId, role: "assistant", parts: [] };
      await this.emit({ type: "add-message", message: msg });
    },
  };
}

type Pipeline = ReturnType<typeof makePipeline>;

function reconcileOf(state: SessionState): Extract<StateDelta, { type: "reconcile" }> {
  return {
    type: "reconcile",
    status: state.status,
    messages: state.messages.map((m) => structuredClone(m)),
  };
}

/** One assistant turn: collapsed thinking, a text burst, a tool call, then a
 *  second text burst whose tail is the tool part (not a text part). */
async function runAssistantTurn(p: Pipeline, runId: string): Promise<void> {
  await p.emit({ type: "session-status", status: "running" });
  await p.emit({
    type: "add-message",
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });
  await p.ensureAssistant(runId);
  await p.emit({ type: "add-part", messageId: runId, part: { type: "reasoning", text: "step 1" } });
  await p.emit({ type: "stream-text", messageId: runId, text: "First burst " });
  await p.emit({ type: "stream-text", messageId: runId, text: "more" });
  await p.emit({
    type: "add-part",
    messageId: runId,
    part: { type: "tool-call", id: "t1", name: "ls", args: "{}" },
  });
  // a NEW text burst after the tool call: the transcript fold must CREATE a
  // fresh text part (tail is a tool-call), never append onto a part the client
  // has not received.
  await p.emit({ type: "stream-text", messageId: runId, text: "Hel" });
  await p.emit({ type: "stream-text", messageId: runId, text: "lo" });
  await p.emit({ type: "stream-text", messageId: runId, text: " world" });
  await p.emit({ type: "session-status", status: "idle" });
}

function expectConverged(state: SessionState, ops: WireOp[]): void {
  // Applying the ops must not throw (the Expected-string regression), and the
  // client must converge to the canonical transcript — no dropped, duplicated,
  // or mis-indexed parts.
  const client = clientState(ops);
  assert.equal(client.status, "idle");
  assert.deepEqual(
    Object.keys(client.messages).sort(),
    state.messages.map((m) => m.id).sort(),
    "client must hold exactly the canonical messages",
  );
  for (const msg of state.messages) {
    assert.deepEqual(client.messages[msg.id], msg, `client message ${msg.id} must equal the canonical transcript`);
  }
}

test("wire fold stream stays client-appliable when the transcript runs ahead of the wire drain", async () => {
  const p = makePipeline(false); // all events folded before the wire drains
  await runAssistantTurn(p, "r1");
  await p.finish();

  assert.deepEqual(p.state.messages[1]!.parts, [
    { type: "reasoning", text: "step 1" },
    { type: "text", text: "First burst more" },
    { type: "tool-call", id: "t1", name: "ls", args: "{}" },
    { type: "text", text: "Hello world" },
  ], "the canonical transcript must not be doubled by mirror folds");
  expectConverged(p.state, p.ops);
});

test("wire fold survives an interleaved text burst after a tool call (Expected-string regression)", async () => {
  const p = makePipeline(true); // drain per event, like the service's for-await
  await p.emit(reconcileOf(p.state));
  await runAssistantTurn(p, "run-9");
  await p.finish();

  assert.deepEqual(p.state.messages[1]!.parts, [
    { type: "reasoning", text: "step 1" },
    { type: "text", text: "First burst more" },
    { type: "tool-call", id: "t1", name: "ls", args: "{}" },
    { type: "text", text: "Hello world" },
  ]);
  expectConverged(p.state, p.ops);
});

test("mirror keeps add-message payloads private — later transcript folds never leak in", () => {
  // A brand-new assistant message is created mid-run: the adapter pushes the
  // LIVE message into its transcript and hands the same object to the wire in
  // the add-message delta (ensureAssistant). The adapter then folds an add-part
  // onto its live object BEFORE the wire mirror folds the same add-part delta.
  const adapterTranscript: SessionState = {
    sessionId: sessionKey,
    studyId: "study-1",
    agentId: "main",
    status: "idle",
    messages: [],
  };
  const liveMsg: Message = { id: "r1", role: "assistant", parts: [] };
  adapterTranscript.messages.push(liveMsg); // ensureAssistant: direct state push
  const wire = new WireOpsBuilder({ status: "idle", messages: [] });
  const ops: WireOp[] = [...snapshot(wire.fold({ type: "add-message", message: liveMsg }))];

  // Gateway frame arrives: the adapter folds it onto its live transcript…
  const delta: StateDelta = { type: "add-part", messageId: "r1", part: { type: "text", text: "hi" } };
  foldState(adapterTranscript, delta);
  // …then the wire mirror folds the same delta. If it had adopted the live
  // message object above, this would push the part a SECOND time.
  ops.push(...snapshot(wire.fold(delta)));

  const client = clientState(ops);
  assert.equal(adapterTranscript.messages[0]!.parts.length, 1);
  assert.deepEqual(
    client.messages.r1.parts,
    [{ type: "text", text: "hi" }],
    "the client must receive exactly one part — the mirror must not re-apply the adapter's fold",
  );
  assert.deepEqual(client.messages.r1, adapterTranscript.messages[0]);
});
