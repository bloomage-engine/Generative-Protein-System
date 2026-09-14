import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { LocalPrincipalResolver, NullWorkspace } from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import type { RuntimeAdapter, SessionState, StateDelta, TransportCommand, WatchSnapshot } from "@science-studio/transport";

function emptyDeltas(): AsyncIterable<StateDelta> {
  return (async function* (): AsyncGenerator<StateDelta, void, unknown> {
    /* empty: the watch endpoint never drives runs */
  })();
}

/** A fake adapter implementing the watch seam so the endpoint can be exercised. */
function makeFakeAdapter(): { adapter: RuntimeAdapter & { push(s: WatchSnapshot): void } } {
  let sink: ((s: WatchSnapshot) => void) | null = null;
  const baseline: WatchSnapshot = { status: "idle", messages: {} };
  const adapter: RuntimeAdapter & { push(s: WatchSnapshot): void } = {
    runtime: "fake",
    init: async () => {},
    run: async (_session: SessionState, _commands: TransportCommand[]) => emptyDeltas(),
    abort: () => {},
    approve: () => {},
    subscribe: (_sessionKey: string, s: (snap: WatchSnapshot) => void) => {
      sink = s;
      s(baseline);
      return () => {
        sink = null;
      };
    },
    push: (snapshot: WatchSnapshot) => {
      sink?.(snapshot);
    },
  };
  return { adapter };
}

async function withServer<T>(fn: (base: string, adapter: ReturnType<typeof makeFakeAdapter>["adapter"]) => Promise<T>): Promise<T> {
  const { adapter } = makeFakeAdapter();
  const app = await createTransportService({ adapters: [adapter] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base, adapter);
  } finally {
    // The NDJSON watch response is keep-alive; drop lingering sockets so
    // close() does not wait on them.
    app.server.closeAllConnections?.();
    await app.close();
  }
}

function readLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<string | null> => {
    while (buffer.indexOf("\n") === -1) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer.slice(0, buffer.indexOf("\n"));
    buffer = buffer.slice(buffer.indexOf("\n") + 1);
    return line;
  };
  return { next, cancel: () => reader.cancel() };
}

test("GET /api/transport/watch streams a baseline NDJSON frame then pushed settles", async () => {
  await withServer(async (base, adapter) => {
    const res = await fetch(`${base}/api/transport/watch`, {
      headers: { accept: "application/x-ndjson" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);
    assert.ok(res.body, "watch must be streaming (no buffering)");

    const { next, cancel } = readLines(res.body);
    const baseline = JSON.parse((await next()) ?? "null") as WatchSnapshot;
    assert.deepEqual(baseline, { status: "idle", messages: {} });

    const updated: WatchSnapshot = {
      status: "idle",
      messages: { r1: { id: "r1", role: "assistant", parts: [{ type: "text", text: "remote" }] } },
    };
    adapter.push(updated);
    const settle = JSON.parse((await next()) ?? "null") as WatchSnapshot;
    assert.deepEqual(settle.messages["r1"], updated.messages["r1"]);

    cancel(); // close the client side; the server's `close` handler detaches the sink
  });
});

test("threadId query parameter is honored (agent: prefix accepted)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/transport/watch?threadId=agent:main:alt`, {
      headers: { accept: "application/x-ndjson" },
    });
    assert.equal(res.status, 200, "an agent: threadId must be accepted, not 400'd");
    res.body?.cancel();
  });
});

test("the watch scopes its Project from the projectId query parameter", async () => {
  const acquired: string[] = [];
  const { adapter } = makeFakeAdapter();
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: {
      acquire: async (_principal, projectId) => {
        acquired.push(projectId);
        return { adapter, workspace: new NullWorkspace(), projectId };
      },
      dispose: async () => {},
    },
    cors: { origin: true },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/transport/watch?projectId=proj-x&threadId=sess-1`,
      { headers: { accept: "application/x-ndjson" } },
    );
    assert.equal(res.status, 200);
    res.body?.cancel();
    assert.deepEqual(acquired, ["proj-x"], "the watch must scope the app's projectId");
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
});
