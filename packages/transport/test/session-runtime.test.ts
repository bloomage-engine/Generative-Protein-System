import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@science-studio/record";
import {
  SessionRuntime,
  textOutput,
  type RunSink,
  type Scheduler,
  type SessionBehavior,
} from "../src/session-runtime.js";
import type { SessionState, StateDelta, TransportCommand } from "../src/types.js";

function session(): SessionState {
  return { sessionId: "s1", projectId: "p1", agentId: "main", status: "idle", messages: [] };
}

function addMessage(id: string, text: string): TransportCommand {
  return { type: "add-message", message: { id, role: "user", content: text } };
}

async function collect(iter: AsyncIterable<StateDelta>): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const delta of iter) out.push(delta);
  return out;
}

function recordingStore(): { sink: RunSink; runs: Run[] } {
  const runs: Run[] = [];
  return { runs, sink: { addRun: async (run) => void runs.push(run) } };
}

const noopDispatch: SessionBehavior<never>["dispatch"] = () => {};

test("probe (zero commands) reconciles first and terminates", async () => {
  const behavior: SessionBehavior<never> = { apply: () => {}, dispatch: noopDispatch };
  const rt = new SessionRuntime<never>("s1", behavior);
  const deltas = await collect(rt.run(session(), []));
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0], { type: "reconcile", status: "idle", messages: [] });
});

test("run echoes every user row then ONE running status", async () => {
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => {
      run.settle(true);
    },
  };
  const rt = new SessionRuntime<never>("s1", behavior);
  const deltas = await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.equal(deltas[0]!.type, "reconcile");
  assert.deepEqual(deltas[1], {
    type: "add-message",
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });
  assert.deepEqual(deltas[2], { type: "session-status", status: "running" });
  // Every user row precedes the single running status.
  assert.equal(deltas.filter((d) => d.type === "add-message").length, 1);
  assert.equal(deltas.filter((d) => d.type === "session-status").length, 1);
});

test("default projection persists a completed Run with the baseline output slice", async () => {
  const { sink, runs } = recordingStore();
  const behavior: SessionBehavior<{ text: string } | { done: true }> = {
    apply(event, ctx) {
      if ("text" in event) {
        ctx.ensureMessage("r1", "assistant");
        ctx.emit({ type: "stream-text", messageId: "r1", text: event.text });
      } else {
        return { settled: true };
      }
    },
    dispatch(_req, run) {
      run.ingest({ text: "answer" });
      run.ingest({ done: true });
    },
  };
  const rt = new SessionRuntime("s1", behavior, { recordStore: sink });
  const deltas = await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.ok(deltas.some((d) => d.type === "add-message" && d.message.id === "r1"));
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.id, "u1");
  assert.equal(run.projectId, "p1");
  assert.equal(run.sessionId, "s1");
  assert.equal(run.agentId, "main");
  assert.equal(run.status, "completed");
  assert.equal(run.input, "hi");
  assert.equal(run.output, "answer");
});

test("projectRun shallow-merges over the default and null persists nothing", async () => {
  const { sink, runs } = recordingStore();
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => run.settle({ status: "aborted", usage: { tokens: 3 } }),
    projectRun: (ctx) => ({ id: "override", parameters: { provider: "x", usage: ctx.directive.usage } }),
  };
  const rt = new SessionRuntime<never>("s1", behavior, { recordStore: sink });
  await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, "override");
  assert.equal(runs[0]!.status, "aborted");
  assert.deepEqual(runs[0]!.parameters, { provider: "x", usage: { tokens: 3 } });

  const skip = new SessionRuntime<never>("s1", { ...behavior, projectRun: () => null }, { recordStore: sink });
  await collect(skip.run(session(), [addMessage("u2", "hi")]));
  assert.equal(runs.length, 1, "a null projection persists nothing");
});

test("a persist failure never escapes into the run stream", async () => {
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => run.settle(true),
  };
  const rt = new SessionRuntime<never>("s1", behavior, {
    recordStore: { addRun: async () => { throw new Error("store down"); } },
    onError: () => {},
  });
  const deltas = await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.equal(deltas[0]!.type, "reconcile");
});

test("prepare runs before the reconcile snapshot", async () => {
  const order: string[] = [];
  const behavior: SessionBehavior<never> = {
    prepare: (handle) => {
      order.push("prepare");
      handle.replaceMessages([{ id: "hist-1", role: "user", parts: [{ type: "text", text: "old" }] }], "idle");
    },
    apply: () => {},
    dispatch: noopDispatch,
  };
  const rt = new SessionRuntime<never>("s1", behavior);
  const deltas = await collect(rt.run(session(), []));
  assert.deepEqual(order, ["prepare"]);
  assert.equal(deltas[0]!.type, "reconcile");
  if (deltas[0]!.type === "reconcile") assert.equal(deltas[0]!.messages[0]!.id, "hist-1");
});

test("watch: in-memory baseline on attach, one snapshot per settle, unsubscribe tears down", async () => {
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => run.settle(true),
  };
  const rt = new SessionRuntime<never>("s1", behavior);
  const seen: unknown[] = [];
  const unsubscribe = rt.subscribe((snapshot) => void seen.push(snapshot));
  assert.equal(seen.length, 0, "unknown Session has no baseline yet");
  await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.equal(seen.length, 1);
  unsubscribe();
  // A later attach of the SAME runtime gets the in-memory baseline.
  const later: unknown[] = [];
  rt.subscribe((snapshot) => void later.push(snapshot));
  assert.equal(later.length, 1);
});

test("watch: coalescing window collapses settles into one push", async () => {
  let pending: (() => void) | null = null;
  const schedule: Scheduler = (flush) => {
    pending = flush;
    return () => {
      pending = null;
    };
  };
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => run.settle(true),
    watch: { coalesceMs: 250 },
  };
  const rt = new SessionRuntime<never>("s1", behavior, { schedule });
  await collect(rt.run(session(), [addMessage("u1", "hi")]));
  const seen: unknown[] = [];
  rt.subscribe((snapshot) => void seen.push(snapshot));
  assert.equal(seen.length, 1, "bootstrapped attach baselines synchronously");
  rt.notify();
  rt.notify();
  assert.equal(seen.length, 1, "pushes coalesce until the window fires");
  assert.equal(typeof pending, "function");
  pending!();
  assert.equal(seen.length, 2, "one flush for the trailing window");
});

test("watch: readBaseline covers a cold Session asynchronously", async () => {
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: noopDispatch,
    watch: {
      readBaseline: async () => ({
        status: "idle",
        messages: { cold: { id: "cold", role: "assistant", parts: [{ type: "text", text: "m" }] } },
      }),
    },
  };
  const rt = new SessionRuntime<never>("s1", behavior);
  const seen: unknown[] = [];
  rt.subscribe((snapshot) => void seen.push(snapshot));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.length, 1);
});

test("a terminal event with no local Run is an ambient settle", async () => {
  const { sink, runs } = recordingStore();
  const behavior: SessionBehavior<{ done: true }> = {
    apply(_event, ctx) {
      ctx.ensureMessage("r9", "assistant");
      ctx.reportRunId("r9");
      return { settled: true };
    },
    dispatch: noopDispatch,
  };
  const rt = new SessionRuntime("s1", behavior, { recordStore: sink });
  const seen: unknown[] = [];
  rt.subscribe((snapshot) => void seen.push(snapshot));
  rt.ingest({ done: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, "r9");
  assert.equal(seen.length, 1);
});

test("abort ends the flow without settling; a late settle still persists", async () => {
  const { sink, runs } = recordingStore();
  let captured: Parameters<SessionBehavior<never>["dispatch"]>[1] | null = null;
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => {
      captured = run;
    },
  };
  const rt = new SessionRuntime<never>("s1", behavior, { recordStore: sink });
  const iterator = rt.run(session(), [addMessage("u1", "hi")])[Symbol.asyncIterator]();
  await iterator.next(); // reconcile
  await iterator.next(); // add-message u1
  await iterator.next(); // session-status running
  rt.abort();
  const end = await iterator.next();
  assert.equal(end.done, true);
  assert.equal(runs.length, 0, "abort does not settle");
  captured!.settle(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs.length, 1, "the late settle is still recorded");
});

test("abort reaches the behavior's cancel with the active run id", async () => {
  const cancelled: Array<[string, string | null]> = [];
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch: (_req, run) => {
      run.targetRunId = "r1";
    },
    cancel: (sessionKey, runId) => {
      cancelled.push([sessionKey, runId]);
    },
  };
  const rt = new SessionRuntime<never>("s1", behavior, {});
  const iterator = rt.run(session(), [addMessage("u1", "hi")])[Symbol.asyncIterator]();
  await iterator.next(); // reconcile
  await iterator.next(); // add-message u1
  await iterator.next(); // session-status running
  rt.abort();
  assert.deepEqual(cancelled, [["s1", "r1"]]);
  const end = await iterator.next();
  assert.equal(end.done, true);
});

test("ctx exposes the claimed target run id and the one-tool-part merge invariant", async () => {
  const seenTargets: (string | null)[] = [];
  const behavior: SessionBehavior<
    { type: "tool-start" } | { type: "tool-end" } | { type: "done" }
  > = {
    apply(event, ctx) {
      seenTargets.push(ctx.targetRunId);
      if (event.type === "tool-start") {
        ctx.ensureMessage("r1", "assistant");
        ctx.mergeToolCall({ messageId: "r1", toolCallId: "t1", name: "read", args: '{"p":1}' });
      }
      if (event.type === "tool-end") {
        ctx.mergeToolCall({ messageId: "r1", toolCallId: "t1", result: "ok" });
      }
      if (event.type === "done") return { settled: true };
    },
    dispatch(_req, run) {
      run.targetRunId = "run-42";
      run.ingest({ type: "tool-start" });
      run.ingest({ type: "tool-end" });
      run.ingest({ type: "done" });
    },
  };
  const rt = new SessionRuntime("s1", behavior);
  await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.deepEqual(seenTargets, ["run-42", "run-42", "run-42"]);
  const assistant = rt.state.messages.find((m) => m.id === "r1")!;
  assert.equal(assistant.parts.length, 1, "start + result coalesce into one part");
  const part = assistant.parts[0]!;
  assert.equal(part.type, "tool-call");
  if (part.type === "tool-call") {
    assert.equal(part.args, '{"p":1}');
    assert.equal(part.result, "ok");
  }
});

test("the reconcile snapshot deep-copies — editing it never touches canonical state", async () => {
  const behavior: SessionBehavior<never> = {
    prepare: (handle) => handle.replaceMessages([{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }], "idle"),
    apply: () => {},
    dispatch: noopDispatch,
  };
  const rt = new SessionRuntime<never>("s1", behavior);
  const first = (await collect(rt.run(session(), [])))[0]!;
  assert.equal(first.type, "reconcile");
  if (first.type === "reconcile") (first.messages[0]!.parts[0] as { text: string }).text = "edited";
  const again = (await collect(rt.run(session(), [])))[0]!;
  if (again.type === "reconcile") {
    assert.equal((again.messages[0]!.parts[0] as { text: string }).text, "hi");
  }
});

test("RunControl.emit pushes a delta and abort ends without settling", async () => {
  const { sink, runs } = recordingStore();
  const behavior: SessionBehavior<never> = {
    apply: () => {},
    dispatch(_req, run) {
      run.emit({ type: "session-status", status: "error" });
      run.abort();
    },
  };
  const rt = new SessionRuntime<never>("s1", behavior, { recordStore: sink });
  const deltas = await collect(rt.run(session(), [addMessage("u1", "hi")]));
  assert.ok(deltas.some((d) => d.type === "session-status" && d.status === "error"));
  assert.equal(runs.length, 0, "abort settles nothing");
});

test("textOutput joins assistant text parts at or after a baseline", () => {
  const messages = [
    { id: "u", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] },
    { id: "a1", role: "assistant" as const, parts: [{ type: "reasoning" as const, text: "r" }, { type: "text" as const, text: "one" }] },
    { id: "a2", role: "assistant" as const, parts: [{ type: "text" as const, text: "two" }] },
  ];
  assert.equal(textOutput(messages), "one\ntwo");
  assert.equal(textOutput(messages, 2), "two");
});
