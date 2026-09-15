import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  apply,
  type BridgeCommandDescriptor,
  type BridgeHost,
  type BridgePreStepDecision,
  type BridgePreStepPayload,
} from "../src/bridge-plugin.js";
import { createCommandBridge } from "../src/bridge.js";

/**
 * The command bridge end to end, over a REAL socket: the child-side plugin
 * (`bridge-plugin.ts`, loaded into the harness child by a launch patch) and the
 * adapter-side client (`bridge.ts`) are driven against each other, with only the
 * two harness services faked. Nothing here spawns a harness.
 */

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
  preStep: () =>
    | ((payload: BridgePreStepPayload, next: () => Promise<BridgePreStepDecision>) => Promise<BridgePreStepDecision>)
    | undefined;
  dispose: () => void;
} {
  const disposers: (() => void)[] = [];
  const executed: string[] = [];
  let effectCalls = 0;
  let preStep: Parameters<NonNullable<BridgeHost["on"]>>[1] | undefined;
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
    // The waterfall is an append-only registration: the last listener registered
    // is the one under test (the plugin registers exactly one).
    on: (_event, listener) => {
      preStep = listener;
      return () => {
        preStep = undefined;
      };
    },
  };
  return {
    ctx,
    effects: () => effectCalls,
    executions: () => executed,
    preStep: () => preStep,
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer();
    },
  };
}

/** Wait for the plugin's `listen` to bind. */
async function waitForPath(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`the bridge never bound ${path}`);
    await delay(10);
  }
}

const DESCRIPTORS: BridgeCommandDescriptor[] = [
  { name: "compact", description: "Condense the conversation" },
  { name: "plan", description: "Enter plan mode", input: { hint: "<message>" } },
];

test("the plugin and the client round-trip over a real socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = join(dir, "b.sock");
  const host = fakeHost(DESCRIPTORS, new Map([["sess-1", { id: "sess-1" }]]));
  try {
    apply(host.ctx, { socket });
    await waitForPath(socket);
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
    assert.equal(existsSync(socket), false, "the disposer removes the socket");
  } finally {
    host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command prompt is run by the registry and its step is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bridge-"));
  const socket = join(dir, "b.sock");
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
  const socket = join(dir, "b.sock");
  const host = fakeHost(DESCRIPTORS);
  try {
    apply(host.ctx, { socket });
    await waitForPath(socket);
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
