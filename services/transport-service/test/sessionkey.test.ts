import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createTransportService } from "../src/index.js";
import type { RuntimeAdapter, SessionState, TransportCommand } from "@science-studio/transport";

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
  const server = createTransportService({ adapters: [adapter] });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
