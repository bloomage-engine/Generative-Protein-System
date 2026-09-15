import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenClawRuntimeAdapter } from "../src/index.js";
import type { BackendGateway, BackendGatewayOptions } from "../src/connection.js";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { SessionState, StateDelta, TransportCommand } from "@science-studio/transport";
import { sessionState } from "@science-studio/contract-tests";

/**
 * Scripted gateway: `chat.history` returns whatever the test currently placed
 * in `state.messages`. Used to replay a "gateway-side session reset" (the
 * history array is emptied between runs) against the real adapter code path.
 * `failSends` models a provider that never accepts the run (ollama down).
 */
function scriptedGateway(
  history: () => unknown[],
  failSends = false,
): (opts: BackendGatewayOptions) => BackendGateway {
  return () => {
    const readyListeners = new Set<() => void>();
    const gateway: BackendGateway = {
      connected: true,
      start: () => {
        for (const l of readyListeners) l();
      },
      stop: () => {},
      // The real `request` is generic over the payload the caller expects; a
      // scripted double cannot know that per method, so it casts its own reply.
      request: async <T,>(method: string): Promise<T> => {
        if (method === "chat.history") return { sessionKey: "s", messages: history() } as T;
        if (method === "chat.send") {
          if (failSends) throw new Error("chat.send failed: model provider unreachable");
          return { runId: "run-1", status: "started" } as T;
        }
        throw new Error(`unexpected request: ${method}`);
      },
      onEvent: () => () => {},
      onReady: (l) => {
        readyListeners.add(l);
        return () => readyListeners.delete(l);
      },
    };
    return gateway;
  };
}

function freshSession(): SessionState {
  return sessionState({ sessionId: "agent:main:main" });
}

function twoTurnHistory(): unknown[] {
  return [
    { id: "h1", role: "user", content: "hi" },
    {
      id: "h2",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    },
  ];
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

test("run() re-syncs the canonical transcript with gateway history after a remote session reset", async () => {
  let gatewayHistory: unknown[] = twoTurnHistory();
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: scriptedGateway(() => gatewayHistory),
  });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: noopRecordStore,
  });

  // First run (a mount probe): no transcript yet, so it seeds from history.
  const firstReconcile = reconcileOf(await collect(adapter, []));
  assert.ok(firstReconcile, "first run must start with a reconcile delta");
  assert.equal(firstReconcile.messages.length, 2, "probe seeds the transcript from gateway history");

  // The session is reset on the gateway side: its history is now empty.
  gatewayHistory = [];

  // Next run (reload probe or a new message) — reconcile must reflect the
  // reset conversation, NOT keep resurrecting the stale history.
  const secondReconcile = reconcileOf(await collect(adapter, []));
  assert.ok(secondReconcile, "second run must start with a reconcile delta");
  assert.equal(
    secondReconcile.messages.length,
    0,
    "reconcile must converge to the reset (empty) conversation instead of the stale in-memory history",
  );
});

test("run() does not wipe a lone never-persisted message when the gateway history is empty", async () => {
  let gatewayHistory: unknown[] = []; // nothing was ever persisted
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: scriptedGateway(() => gatewayHistory, true), // chat.send always fails
  });
  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: noopRecordStore,
  });

  // One turn: the user message is folded into the transcript, but `chat.send`
  // fails (provider down) so nothing is ever persisted at the gateway.
  const failed = await collect(adapter, [
    { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
  ]);
  assert.equal(failed.filter((d) => d.type === "add-message").length, 1);

  // An empty gateway history here means "not persisted yet", not "reset" —
  // a lone failed-send message must survive the sync.
  const probeReconcile = reconcileOf(await collect(adapter, []));
  assert.equal(
    probeReconcile?.messages.length,
    1,
    "a lone never-persisted user message must survive an empty gateway history",
  );
});
