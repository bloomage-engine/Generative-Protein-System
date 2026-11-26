import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  apply,
  type BridgeAssistantStreamPayload,
  type BridgeCommandDescriptor,
  type BridgeHost,
  type BridgePreStepDecision,
  type BridgePreStepPayload,
} from "../src/bridge-plugin.js";
import { bridgeSocketPath, createCommandBridge } from "../src/bridge.js";

/**
 * The command bridge end to end, over a REAL socket: the child-side plugin
 * (`bridge-plugin.ts`, loaded into the harness child by a launch patch) and the
 * adapter-side client (`bridge.ts`) are driven against each other, with only the
 * two harness services faked. Nothing here spawns a harness.
 */

type PreStepListener = (
  payload: BridgePreStepPayload,
  next: () => Promise<BridgePreStepDecision>,
) => Promise<BridgePreStepDecision>;
type StreamListener = (payload: BridgeAssistantStreamPayload) => void;

/** The plugin's two services, scripted: a live agent, a catalog, and outcomes. */
function fakeHost(
  descriptors: readonly BridgeCommandDescriptor[] = [],
  agents: ReadonlyMap<string, object> = new Map(),
): {
  ctx: BridgeHost;
  effects: () => number;
  /** Every line the registry was asked to run, in order. */
  executions: () => string[];
  /** The `agent/pre-step` listener the plugin registered, if any. */
  preStep: () => PreStepListener | undefined;
  stream: () => StreamListener | undefined;
  dispose: () => void;
} {
  const disposers: (() => void)[] = [];
  const executed: string[] = [];
  let effectCalls = 0;
  const preStepListeners: PreStepListener[] = [];
  const streamListeners: StreamListener[] = [];
  const ctx: BridgeHost = {
    commands: {
      list: () => descriptors,
      execute: async (_agent, line) => {
        executed.push(line);
        if (line === "/boom") throw new Error("handler exploded");
        if (line === "/compact") return { result: { kind: "success", text: "Condensed 12 items" } };
        return undefined;
      },
    },
    agents: {
      get: (id) => agents.get(id),
      roots: () => [...agents.values()],
      list: () => [...agents.values()],
    },
    effect: (body) => {
      effectCalls += 1;
      disposers.push(body());
    },
    on: ((event: string, listener: (...args: unknown[]) => unknown) => {
      const bucket = event === "agent/assistant-stream" ? streamListeners : preStepListeners;
      bucket.push(listener as never);
      return () => {
        const index = bucket.indexOf(listener as never);
        if (index >= 0) bucket.splice(index, 1);
      };
    }) as unknown as NonNullable<BridgeHost["on"]>,
  };
  return {
    ctx,
    effects: () => effectCalls,
    executions: () => executed,
    preStep: () => preStepListeners[0],
    stream: () => streamListeners[0],
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer();
    },
  };
}

/** Wait for the plugin to answer; a win32 named pipe has no filesystem entry. */
async function waitForBridge(endpoint: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await createCommandBridge(endpoint).list();
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`the bridge never answered ${endpoint}: ${String(err)}`);
      }
      await delay(10);
    }
  }
}

const DESCRIPTORS: BridgeCommandDescriptor[] = [
  { name: "compact", description: "Condense the conversation" },
  { name: "plan", description: "Enter plan mode", input: { hint: "<message>" } },
];

test("the plugin and the client round-trip over a real socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", { id: "sess-1" }]]));
  try {
    apply(host.ctx, { socket });
    await waitForBridge(socket);
    const bridge = createCommandBridge(socket);

    assert.deepEqual(await bridge.list(), [
      { name: "compact", description: "Condense the conversation" },
      { name: "plan", description: "Enter plan mode", input: { hint: "<message>" } },
    ]);

    assert.deepEqual(await bridge.execute("sess-1", "/compact"), {
      status: "ok",
      kind: "success",
      text: "Condensed 12 items",
    });
    // A syntactically valid line the registry does not know: `execute` answers
    // `undefined` and the registry logs nothing.
    assert.deepEqual(await bridge.execute("sess-1", "/nope"), { status: "unknown" });
    // An execution targets ONE exact session's agent.
    assert.deepEqual(await bridge.execute("ghost", "/compact"), { status: "no-agent" });
    // A throwing handler settles as an error on the wire; the client reports the
    // harness as unavailable rather than inventing a different shape.
    const failed = await bridge.execute("sess-1", "/boom");
    assert.equal(failed.status, "unavailable");
    assert.match(failed.status === "unavailable" ? failed.message : "", /handler exploded/);

    host.dispose();
    if (process.platform === "win32") {
      await assert.rejects(() => createCommandBridge(socket).list());
    } else {
      assert.equal(existsSync(socket), false, "the disposer removes the socket");
    }
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command prompt is run by the registry and its step is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const agent = { id: "sess-1" };
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", agent]]));
  try {
    apply(host.ctx, { socket });
    const listener = host.preStep();
    assert.ok(listener, "the plugin registers an agent/pre-step listener");

    const entered: BridgePreStepDecision[] = [];
    const next = async (): Promise<BridgePreStepDecision> => {
      const decision: BridgePreStepDecision = { kind: "enter" };
      entered.push(decision);
      return decision;
    };
    const prompt = (text: string): BridgePreStepPayload => ({
      agent,
      messages: [{ content: [{ type: "text", text }], source: { kind: "user" } }],
      signal: new AbortController().signal,
    });

    // A cold session's `/compact` arrives as this session's FIRST prompt: the
    // registry runs it and the step is rejected, so no model call happens.
    assert.deepEqual(await listener(prompt("/compact"), next), { kind: "reject" });
    assert.deepEqual(host.executions(), ["/compact"]);
    assert.deepEqual(entered, [], "the step never enters");

    // A line the registry does not resolve is still rejected: a command line is
    // never allowed to reach the model.
    assert.deepEqual(await listener(prompt("/nope"), next), { kind: "reject" });
    assert.deepEqual(host.executions(), ["/compact", "/nope"]);

    // An ordinary prompt is not this listener's business.
    assert.deepEqual(await listener(prompt("hello there"), next), { kind: "enter" });
    assert.deepEqual(host.executions(), ["/compact", "/nope"], "a model turn runs no command");

    // A malformed line, or one carrying an attachment, is not a command line.
    await listener(prompt("/PLAN"), next);
    await listener(
      {
        agent,
        messages: [
          {
            content: [{ type: "text", text: "/plan" }, { type: "image" }],
            source: { kind: "user" },
          },
        ],
        signal: new AbortController().signal,
      },
      next,
    );
    assert.deepEqual(host.executions(), ["/compact", "/nope"]);

    // Model-facing context another plugin injected is not what the user typed:
    // the step is a model turn, however command-shaped the prompt looks.
    await listener(
      { agent, messages: [{ content: [{ type: "text", text: "Current time: 12:00" }], source: { kind: "plugin" } }] },
      next,
    );
    assert.deepEqual(host.executions(), ["/compact", "/nope"]);

    // A failing handler is contained: the step is still rejected.
    assert.deepEqual(await listener(prompt("/boom"), next), { kind: "reject" });
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("listing never invents an agent: with none live the catalog is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const host = fakeHost(DESCRIPTORS);
  try {
    apply(host.ctx, { socket });
    await waitForBridge(socket);
    assert.deepEqual(await createCommandBridge(socket).list(), []);
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing socket config disables the bridge instead of failing the child", () => {
  const host = fakeHost(DESCRIPTORS);
  const original = process.stderr.write;
  // The plugin may only ever write one stderr line here; the child's stdout is
  // the JSON-RPC wire, and a throwing plugin would fail the whole boot.
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => apply(host.ctx, undefined));
    assert.doesNotThrow(() => apply(host.ctx, { socket: "" }));
    assert.equal(host.effects(), 0, "no server is created without a socket");
  } finally {
    process.stderr.write = original;
  }
  host.dispose();
});

test("a client pointed at a dead socket names the endpoint it could not reach", async () => {
  const endpoint = join(tmpdir(), "dsh-bridge-absent", "nope.sock");
  const bridge = createCommandBridge(endpoint);
  await assert.rejects(() => bridge.list(), /nope\.sock/);
  const outcome = await bridge.execute("sess-1", "/compact");
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.status === "unavailable" ? outcome.message : "", /nope\.sock/);
});

test("the child forwards live assistant frames as NDJSON over the bridge socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", { id: "sess-1" }]]));
  try {
    apply(host.ctx, { socket });
    await waitForBridge(socket);
    const messages: { sessionId: string; frame: unknown }[] = [];
    const close = createCommandBridge(socket).subscribeAssistantStream!((message) => messages.push(message));
    // The plugin registers its listener when the adapter's GET arrives.
    await delay(50);

    const listener = host.stream();
    assert.ok(listener, "the plugin registers an agent/assistant-stream listener");
    listener({
      agent: { session: { id: "sess-1" } },
      frame: {
        type: "chunk",
        attemptId: "sess-1:1",
        revision: 3,
        turn: 1,
        step: 1,
        index: 0,
        chunk: { type: "text-delta", index: 0, text: "hi" },
      },
    });
    // A frame with no session id is dropped, not forwarded.
    listener({ agent: {}, frame: { type: "start" } });

    await delay(50);
    assert.deepEqual(messages, [
      {
        sessionId: "sess-1",
        frame: {
          type: "chunk",
          attemptId: "sess-1:1",
          revision: 3,
          turn: 1,
          step: 1,
          index: 0,
          chunk: { type: "text-delta", index: 0, text: "hi" },
        },
      },
    ]);

    close();
    await delay(50);
    // After the client closes, the plugin disposes its listener.
    assert.equal(host.stream(), undefined);
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupt cancels the exact session's agent over the bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const cancelled: Array<[unknown, unknown]> = [];
  const agent = {
    id: "sess-1",
    cancel: (cause: unknown, options?: unknown) => {
      cancelled.push([cause, options]);
    },
  };
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", agent]]));
  try {
    apply(host.ctx, { socket });
    await waitForBridge(socket);
    const bridge = createCommandBridge(socket);

    assert.equal(await bridge.interrupt("sess-1"), "ok");
    // The harness's own mid-turn cancel, with queued work preserved.
    assert.deepEqual(cancelled, [[{ kind: "user" }, { keepInbox: true }]]);

    // A session with no live agent has nothing to cancel.
    assert.equal(await bridge.interrupt("ghost"), "no-agent");
    assert.equal(cancelled.length, 1);
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupt reports an agent without a cancel method, and resolves by session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = bridgeSocketPath(dir);
  const cancelled: string[] = [];
  // Registered under a DIFFERENT key than the session id; only `session.id`
  // matches, so the fallback scan is what must resolve it.
  const agent = {
    id: "agent-1",
    session: { id: "sess-2" },
    cancel: () => {
      cancelled.push("sess-2");
    },
  };
  const noCancel = { id: "sess-3" };
  const host = fakeHost(DESCRIPTORS, new Map([["agent-1", agent], ["sess-3", noCancel]]));
  try {
    apply(host.ctx, { socket });
    await waitForBridge(socket);
    const bridge = createCommandBridge(socket);

    assert.equal(await bridge.interrupt("sess-2"), "ok", "resolved through agent.session.id");
    assert.deepEqual(cancelled, ["sess-2"]);

    assert.equal(await bridge.interrupt("sess-3"), "no-cancel");
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
