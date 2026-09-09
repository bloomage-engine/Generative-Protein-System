import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createTransportService } from "../src/index.js";
import type { RuntimeAdapter, SessionState, TransportCommand } from "@science-studio/transport";

/** A dsh-runtime fake that records the session key each run() was given. */
function makeDshAdapter(seen: { sessionId: string | null }): RuntimeAdapter {
  return {
    runtime: "dsh",
    init: async () => {},
    run: async function* (session: SessionState, _commands: TransportCommand[]) {
      seen.sessionId = session.sessionId;
    },
    abort: () => {},
    approve: () => {},
  };
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

test("dsh: assistant-ui local-mint threadIds fall back to the default session so probes and sends converge", async () => {
  const prev = process.env.DSH_DEFAULT_SESSION;
  process.env.DSH_DEFAULT_SESSION = "dshtest-default";
  const seen = { sessionId: null as string | null };
  const adapter = makeDshAdapter(seen);
  const server = createTransportService({ adapters: [adapter] });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await postProbe(base, "__LOCALID_abc123");
    assert.equal(seen.sessionId, "dshtest-default", "an assistant-ui local-mint id must resolve to the default session");

    await postProbe(base, null);
    assert.equal(seen.sessionId, "dshtest-default", "an absent threadId (mount probe) resolves to the same default");

    await postProbe(base, "sess-real-1");
    assert.equal(seen.sessionId, "sess-real-1", "a stable client-chosen session id still passes through");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prev === undefined) delete process.env.DSH_DEFAULT_SESSION;
    else process.env.DSH_DEFAULT_SESSION = prev;
  }
});
