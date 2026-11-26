/**
 * End-to-end test of this example's wiring: the openclaw adapter driven by a
 * SCRIPTED gateway (via the adapter's `createGateway` test seam — the same
 * pattern as packages/transport-openclaw/test/subscribe.test.ts) behind
 * @gps/transport-service, speaking the assistant-transport SSE
 * wire protocol to a plain fetch client. No live gateway needed.
 *
 * Prereq: `npm run build` at the repo root (the workspace deps are imported
 * from their dist builds, as in services/transport-service).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenClawRuntimeAdapter,
  type OpenClawRuntimeAdapterOptions,
} from "@gps/transport-openclaw";
import { createTransportService } from "@gps/transport-service";

const SESSION = "agent:main:main";

type GatewayFactory = NonNullable<OpenClawRuntimeAdapterOptions["createGateway"]>;

/**
 * Scripted gateway: `chat.history` serves `history`; `chat.send` streams two
 * text deltas and a `final` frame (the exact shapes subscribe.test.ts drives)
 * before resolving with a runId — the second delta exercises the wire's
 * `append-text` path (first delta materializes as a `set` on the new part).
 * `commands.list` serves `commandEntries` (empty by default).
 */
function scriptedFactory(history: unknown[], commandEntries: unknown[] = []): GatewayFactory {
  return (() => {
    let eventCb: ((frame: unknown) => void) | null = null;
    const readyListeners = new Set<() => void>();
    const gw = {
      connected: true,
      start: () => {
        for (const l of readyListeners) l();
      },
      stop: () => {},
      request: (method: string): Promise<unknown> => {
        if (method === "chat.history") {
          return Promise.resolve({ sessionKey: SESSION, messages: history });
        }
        if (method === "commands.list") {
          return Promise.resolve({ commands: commandEntries });
        }
        if (method === "chat.send") {
          eventCb?.({
            event: "chat",
            payload: { sessionKey: SESSION, state: "delta", runId: "run-1", deltaText: "Hello " },
          });
          eventCb?.({
            event: "chat",
            payload: {
              sessionKey: SESSION,
              state: "delta",
              runId: "run-1",
              deltaText: "from the scripted gateway.",
            },
          });
          eventCb?.({
            event: "chat",
            payload: { sessionKey: SESSION, state: "final", runId: "run-1" },
          });
          return Promise.resolve({ runId: "run-1", status: "started" });
        }
        return Promise.reject(new Error(`unexpected request: ${method}`));
      },
      onEvent: (cb: (frame: unknown) => void) => {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
      onReady: (l: () => void) => {
        readyListeners.add(l);
        return () => {
          readyListeners.delete(l);
        };
      },
    };
    return gw;
  }) as unknown as GatewayFactory;
}

interface WireOp {
  type: "set" | "append-text";
  path: string[];
  value: unknown;
}

/** Parse an SSE body into its `update-state` ops, keeping `[DONE]` visible. */
function parseSse(body: string): { ops: WireOp[]; done: boolean } {
  const ops: WireOp[] = [];
  let done = false;
  for (const frame of body.split("\n\n")) {
    if (!frame.startsWith("data: ")) continue;
    const data = frame.slice("data: ".length).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const parsed = JSON.parse(data) as { type: string; operations: WireOp[] };
    if (parsed.type === "update-state") ops.push(...parsed.operations);
  }
  return { ops, done };
}

/** Boot the example wiring (scripted adapter → transport-service) on an ephemeral port. */
async function bootExample(
  history: unknown[],
  commandEntries: unknown[] = [],
): Promise<{ base: string; close: () => Promise<void> }> {
  const adapter = new OpenClawRuntimeAdapter({
    createGateway: scriptedFactory(history, commandEntries),
  });
  const app = await createTransportService({ adapters: [adapter] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object", "server must be listening on a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      // The SSE endpoint sets `connection: keep-alive`; drop lingering sockets
      // or close() waits for them and the test hangs.
      app.server.closeAllConnections?.();
      await app.close();
    },
  };
}

test("probe (empty commands) converges to the gateway history and terminates with [DONE]", async () => {
  const history = [
    { id: "hU", role: "user", content: "hi from the gateway history" },
    { id: "hA", role: "assistant", content: [{ type: "text", text: "hello back" }] },
  ];
  const { base, close } = await bootExample(history);
  try {
    const res = await fetch(`${base}/api/transport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: [], state: { status: "idle", messages: {} }, threadId: null }),
    });
    assert.equal(res.status, 200);
    const { ops, done } = parseSse(await res.text());
    assert.equal(done, true, "the probe stream must terminate with [DONE]");

    const snapshot = ops.find((op) => op.type === "set" && op.path.length === 1 && op.path[0] === "messages");
    assert.ok(snapshot, "a drifted client must receive a whole-message-map set");
    const messages = snapshot!.value as Record<string, { role: string; parts: { type: string; text?: string }[] }>;
    assert.equal(messages["hU"]?.role, "user", "the gateway's USER row must be in the snapshot");
    assert.equal(messages["hU"]?.parts.find((p) => p.type === "text")?.text, "hi from the gateway history");
    assert.equal(messages["hA"]?.parts.find((p) => p.type === "text")?.text, "hello back");
    assert.ok(
      ops.every((op) => op.type === "set" || op.type === "append-text"),
      "only client-safe op types may appear on the wire",
    );
  } finally {
    await close();
  }
});

test("run (add-message) streams the reply as set/append-text ops and terminates with [DONE]", async () => {
  const { base, close } = await bootExample([]);
  try {
    const res = await fetch(`${base}/api/transport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          {
            type: "add-message",
            message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          },
        ],
        state: { status: "idle", messages: {} },
        threadId: null,
      }),
    });
    assert.equal(res.status, 200);
    const { ops, done } = parseSse(await res.text());
    assert.equal(done, true, "the run stream must terminate with [DONE]");

    const userSet = ops.find(
      (op) => op.type === "set" && op.path.length === 2 && op.path[0] === "messages" && op.path[1] === "u1",
    );
    assert.ok(userSet, "the echoed user message must arrive as a set at messages/u1");
    assert.equal((userSet!.value as { role: string }).role, "user");

    const running = ops.find((op) => op.type === "set" && op.path.length === 1 && op.path[0] === "status" && op.value === "running");
    const idle = ops.find((op) => op.type === "set" && op.path.length === 1 && op.path[0] === "status" && op.value === "idle");
    assert.ok(running, "the session must flip to running");
    assert.ok(idle, "the session must settle back to idle");
    assert.ok(
      running && idle && ops.indexOf(running) < ops.indexOf(idle),
      "running must precede the final idle",
    );

    const append = ops.find((op) => op.type === "append-text");
    assert.ok(append, "the streamed token fragment must arrive as an append-text op");
    assert.equal(append!.value, "from the scripted gateway.", "append-text carries the exact fragment");
    assert.deepEqual(
      append!.path,
      ["messages", "run-1", "parts", "0", "text"],
      "append-text must target the trailing text part's text field",
    );
    assert.ok(
      ops.every((op) => op.type === "set" || op.type === "append-text"),
      "only client-safe op types may appear on the wire",
    );
  } finally {
    await close();
  }
});

test("GET /api/transport/commands serves the curated runtime command catalog", async () => {
  const entries = [
    { name: "status", description: "status desc", source: "native", scope: "both", acceptsArgs: false, category: "status" },
    { name: "help", description: "help desc", source: "native", scope: "text", acceptsArgs: false, category: "status" },
    {
      name: "model",
      description: "model desc",
      source: "native",
      scope: "both",
      acceptsArgs: true,
      args: [{ name: "name", description: "model", type: "string" }],
    },
    {
      name: "think",
      description: "think desc",
      source: "native",
      scope: "both",
      acceptsArgs: true,
      args: [{ name: "level", description: "level", type: "string", required: true }],
    },
    { name: "new", description: "new session", source: "native", scope: "both", acceptsArgs: false, category: "session" },
    { name: "debug", description: "debug", source: "plugin", scope: "both", acceptsArgs: false },
  ];
  const { base, close } = await bootExample([], entries);
  try {
    const res = await fetch(`${base}/api/transport/commands`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { commands: { id: string; invocationText: string }[] };
    assert.deepEqual(
      body.commands.map((c) => c.id).sort(),
      ["help", "model", "status"],
      "only allowlisted native no-required-arg text commands are served",
    );
    assert.equal(body.commands.find((c) => c.id === "status")!.invocationText, "/status");
  } finally {
    await close();
  }
});
