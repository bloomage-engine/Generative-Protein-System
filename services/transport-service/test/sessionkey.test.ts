import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createTransportService } from "../src/index.js";
import type { RuntimeAdapter, SessionState, TransportCommand } from "@gps/transport";

/**
 * The service is runtime-agnostic: which threadId means which session is the
 * ADAPTER's call (`RuntimeAdapter.resolveSessionKey`). These tests pin the
 * funnel — the service passes the claimed threadId through and drives the
 * adapter's run with the returned key — and the no-adapter-knowledge default.
 */
function makeAdapter(
  seen: { sessionId: string | null },
  resolve?: (threadId: string | null) => string,
): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* (session: SessionState, _commands: TransportCommand[]) {
      seen.sessionId = session.sessionId;
    },
    abort: () => {},
    approve: () => {},
    ...(resolve !== undefined ? { resolveSessionKey: resolve } : {}),
  };
}

async function withServer<T>(adapter: RuntimeAdapter, fn: (base: string) => Promise<T>): Promise<T> {
  const app = await createTransportService({ adapters: [adapter] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

async function postProbe(base: string, threadId: string | null): Promise<void> {
  const res = await fetch(`${base}/api/transport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: [], state: { status: "idle", messages: {} }, threadId }),
  });
  assert.equal(res.status, 200);
  await res.text(); // drain; the probe terminates with [DONE]
}

test("the service funnels the claimed threadId to the adapter's resolveSessionKey", async () => {
  const seen = { sessionId: null as string | null };
  const claimed: (string | null)[] = [];
  const adapter = makeAdapter(seen, (t) => {
    claimed.push(t);
    return `mapped-${t ?? "none"}`;
  });
  await withServer(adapter, async (base) => {
    await postProbe(base, "agent:main:alt");
    assert.equal(seen.sessionId, "mapped-agent:main:alt", "the run targets the key the adapter returned");
    assert.deepEqual(claimed, ["agent:main:alt"]);

    await postProbe(base, null);
    assert.equal(seen.sessionId, "mapped-none", "the mount probe claims no session (null)");
  });
});

test("runtimes without resolveSessionKey accept a threadId verbatim and default an absent one", async () => {
  const seen = { sessionId: null as string | null };
  const adapter = makeAdapter(seen);
  await withServer(adapter, async (base) => {
    await postProbe(base, "agent:main:alt");
    assert.equal(seen.sessionId, "agent:main:alt", "a non-empty threadId passes through unchanged");
    await postProbe(base, null);
    assert.equal(seen.sessionId, "default", "an absent threadId means the default session");
  });
});

test("the explicit query scope wins over the body's local-mint threadId", async () => {
  const seen = { sessionId: null as string | null };
  // Mirrors the real adapters: assistant-ui's per-page local id must not become
  // the canonical session.
  const adapter = makeAdapter(seen, (t) =>
    t !== null && !t.startsWith("__LOCALID_") ? t : "default-session",
  );
  await withServer(adapter, async (base) => {
    // A SEND: assistant-ui builds this body itself and always puts its local
    // `__LOCALID_*` there, while the URL carries the Session the app selected.
    const res = await fetch(`${base}/api/transport?threadId=sess-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          { type: "add-message", message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        ],
        state: { status: "idle", messages: {} },
        threadId: "__LOCALID_abc123",
      }),
    });
    assert.equal(res.status, 200);
    await res.text(); // drain; the run terminates with [DONE]
    assert.equal(
      seen.sessionId,
      "sess-1",
      "the URL's Session must win over the body's local id (else sends land on the default session and the reply reconciles against the wrong transcript)",
    );
  });
});
