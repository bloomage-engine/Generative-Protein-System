import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFrame } from "@openclaw/gateway-client/browser";
import { sessionState } from "@gps/contract-tests";
import type { BackendGateway } from "../src/connection.js";
import { OpenClawRuntimeAdapter } from "../src/index.js";

const SESSION = "agent:main:main";

/**
 * The gateway supports mid-turn cancellation (`chat.abort`), so abort must
 * reach it with the active run id — otherwise a follow-up message would queue
 * behind a long-running turn.
 */
test("abort issues chat.abort for the active gateway run", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: (): BackendGateway => {
      const readyListeners = new Set<() => void>();
      return {
        connected: true,
        start: () => {
          for (const listener of readyListeners) listener();
        },
        stop: () => {},
        request: async <T,>(method: string, params?: unknown): Promise<T> => {
          requests.push({ method, params });
          if (method === "chat.history") return { sessionKey: SESSION, messages: [] } as T;
          if (method === "chat.send") return { runId: "run-1", status: "started" } as T;
          if (method === "chat.abort") return {} as T;
          throw new Error(`unexpected request: ${method}`);
        },
        onEvent: (_cb: (frame: EventFrame) => void) => () => {},
        onReady: (listener: () => void) => {
          readyListeners.add(listener);
          return () => readyListeners.delete(listener);
        },
      };
    },
  });

  await adapter.init({
    binding: { runtime: "openclaw", config: { url: "ws://fake", token: "token" } },
    recordStore: { addRun: async () => {} },
  });

  // Drive a turn but emit no terminal frame, so it stays in flight.
  const turn = (async () => {
    for await (const _delta of adapter.run(sessionState({ sessionId: SESSION }), [
      { type: "add-message", message: { id: "u1", role: "user", content: "hi" } },
    ])) {
      // drain
    }
  })();
  // Let `chat.send` resolve so the active Run knows its gateway runId.
  await new Promise((resolve) => setTimeout(resolve, 10));

  adapter.abort();

  const abort = requests.find((entry) => entry.method === "chat.abort");
  assert.ok(abort, "abort issues chat.abort");
  assert.deepEqual(abort.params, { sessionKey: SESSION, runId: "run-1" });

  await turn;
});
