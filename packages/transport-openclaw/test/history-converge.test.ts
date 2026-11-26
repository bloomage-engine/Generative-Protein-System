import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionState } from "@gps/contract-tests";
import { OpenClawRuntimeAdapter } from "../src/index.js";
import type { BackendGateway, BackendGatewayOptions } from "../src/connection.js";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { SessionState, StateDelta, TransportCommand } from "@gps/transport";

type ScriptedGateway = BackendGateway & { emit(frame: EventFrame): void };

/**
 * Scripted gateway with event injection: `chat.history` returns whatever the
 * test currently placed in `history`, `chat.send` resolves with `run-1`, and
 * the test pushes gateway frames through the captured `onEvent` callback.
 */
function scriptedGateway(history: () => unknown[]): (opts: BackendGatewayOptions) => BackendGateway {
  return (opts) => {
    void opts;
    const readyListeners = new Set<() => void>();
    let eventCb: ((frame: EventFrame) => void) | null = null;
    const gw: ScriptedGateway = {
      connected: true,
      start: () => {
        for (const l of readyListeners) l();
      },
      stop: () => {},
      // The real `request` is generic over the payload the caller expects; a
      // scripted double cannot know that per method, so it casts its own reply.
      request: async <T,>(method: string): Promise<T> => {
        if (method === "chat.history") return { sessionKey: "s", messages: history() } as T;
        if (method === "chat.send") return { runId: "run-1", status: "started" } as T;
        throw new Error(`unexpected request: ${method}`);
      },
      onEvent: (cb) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
      onReady: (l) => {
        readyListeners.add(l);
        return () => readyListeners.delete(l);
      },
      emit: (frame) => eventCb?.(frame),
    };
    return gw;
  };
}

function freshSession(): SessionState {
  return sessionState({ sessionId: "agent:main:main" });
}

async function collect(adapter: OpenClawRuntimeAdapter, commands: TransportCommand[]): Promise<StateDelta[]> {
  const out: StateDelta[] = [];
  for await (const d of adapter.run(freshSession(), commands)) out.push(d);
  return out;
}

function reconcileOf(deltas: StateDelta[]): Extract<StateDelta, { type: "reconcile" }> | undefined {
  return deltas.find((d): d is Extract<StateDelta, { type: "reconcile" }> => d.type === "reconcile");
}

const noopRecordStore = { addRun: async () => {} };

async function makeAdapter(
  history: () => unknown[],
): Promise<{ adapter: OpenClawRuntimeAdapter; gw: ScriptedGateway }> {
  let captured: ScriptedGateway | undefined;
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: (opts) => {
      captured = scriptedGateway(history)(opts) as ScriptedGateway;
      return captured;
    },
  });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: noopRecordStore,
  });
  return { adapter, gw: captured! };
}

/** Drive one full local exchange (user "hi" -> streamed "hello" -> final). */
async function runLocalExchange(adapter: OpenClawRuntimeAdapter, gw: ScriptedGateway): Promise<void> {
  const deltas = collect(adapter, [
    { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
  ]);
  // Let run() attach the flow and resolve `chat.send` before feeding events.
  await new Promise((r) => setTimeout(r, 10));
  gw.emit({
    event: "chat",
    payload: { sessionKey: "agent:main:main", state: "delta", runId: "run-1", deltaText: "hello" },
  } as unknown as EventFrame);
  gw.emit({
    event: "chat",
    payload: { sessionKey: "agent:main:main", state: "final", runId: "run-1" },
  } as unknown as EventFrame);
  await deltas;
}

test("run() converges the transcript with gateway rows that arrived remotely (missing user turns)", async () => {
  let history: unknown[] = [];
  const { adapter } = await makeAdapter(() => history);

  // Seed an initial exchange.
  history = [
    { id: "h1", role: "user", content: "hi" },
    { id: "h2", role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  const first = reconcileOf(await collect(adapter, []));
  assert.equal(first?.messages.length, 2);

  // The conversation continues on the openclaw side (a different client):
  // new user + assistant rows land in the gateway history.
  history = [
    ...history,
    { id: "h3", role: "user", content: "and what about enzymes?" },
    { id: "h4", role: "assistant", content: [{ type: "text", text: "enzymes catalyze" }] },
  ];

  // Next probe must converge to the FULL gateway conversation — including the
  // remote USER rows — not keep serving the stale in-memory transcript.
  const second = reconcileOf(await collect(adapter, []));
  assert.ok(second);
  assert.deepEqual(
    second.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  const userTexts = second.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text));
  assert.deepEqual(userTexts, ["hi", "and what about enzymes?"]);
});

test("a locally-completed exchange matching the gateway mirror keeps its transcript ids", async () => {
  let history: unknown[] = [];
  const { adapter, gw } = await makeAdapter(() => history);
  await runLocalExchange(adapter, gw);

  // The gateway now persisted the same exchange (different row ids).
  history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  const probe = reconcileOf(await collect(adapter, []));
  assert.deepEqual(
    probe?.messages.map((m) => m.id),
    ["u1", "run-1"],
    "an equal gateway mirror must not rebuild/re-id the transcript",
  );
});

test("a gateway lagging behind the transcript does not wipe the local tail", async () => {
  const history: unknown[] = [
    { id: "h1", role: "user", content: "hi" },
    { id: "h2", role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  const { adapter, gw } = await makeAdapter(() => history);

  // Probe seeds the two gateway rows...
  await collect(adapter, []);
  // ...then a new local exchange happens while the gateway mirror the test
  // returns stays behind (transcript has a longer, gateway-prefixed tail).
  await runLocalExchange(adapter, gw);
  // The extra exchange added u1/run-1 rows locally; history never grew, so
  // the transcript is gateway + local tail. A probe must keep that tail.
  const probe = reconcileOf(await collect(adapter, []));
  assert.equal(probe?.messages.length, 4);
  assert.deepEqual(
    probe?.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});
