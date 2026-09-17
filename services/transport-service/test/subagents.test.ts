import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { RuntimeAdapter, SessionState, SubagentRun, TransportCommand } from "@science-studio/transport";
import { createTransportService } from "../src/index.js";

async function withAdapter<T>(adapter: RuntimeAdapter, fn: (base: string) => Promise<T>): Promise<T> {
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

const emptyAdapter: RuntimeAdapter = {
  runtime: "fake",
  init: async () => {},
  run: async function* (_session: SessionState, _commands: TransportCommand[]) {},
  abort: () => {},
};

test("GET /api/transport/subagents returns the Project adapter's live list", async () => {
  const run: SubagentRun = {
    id: "child-1",
    parentId: "sess-1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  };
  const adapter: RuntimeAdapter = { ...emptyAdapter, subagents: async () => [run] };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [run] });
  });
});

test("GET /api/transport/subagents answers empty when the runtime has no surface", async () => {
  await withAdapter(emptyAdapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [] });
  });
});

test("GET /api/transport/subagents degrades to empty when the adapter throws", async () => {
  const adapter: RuntimeAdapter = {
    ...emptyAdapter,
    subagents: async () => {
      throw new Error("boom");
    },
  };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subagents: [] });
  });
});
