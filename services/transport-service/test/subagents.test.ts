import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { RuntimeAdapter, SessionState, SubagentRun, SubagentTranscript, TransportCommand } from "@science-studio/transport";
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

test("GET /api/transport/subagents/:childId/transcript serves the adapter's record", async () => {
  const transcript: SubagentTranscript = { id: "child-1", parentId: "sess-1", messages: [] };
  const adapter: RuntimeAdapter = {
    ...emptyAdapter,
    subagentTranscript: async (sessionKey, childId) =>
      sessionKey === "sess-1" && childId === "child-1" ? transcript : null,
  };
  await withAdapter(adapter, async (base) => {
    const ok = await fetch(`${base}/api/transport/subagents/child-1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { transcript });
    const missing = await fetch(`${base}/api/transport/subagents/nobody/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(missing.status, 404, "a null answer is a 404");
  });
});

test("GET .../transcript answers 404 when the runtime has no surface and 400 on an unsafe id", async () => {
  await withAdapter(emptyAdapter, async (base) => {
    const res = await fetch(`${base}/api/transport/subagents/child-1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(res.status, 404, "no subagentTranscript member → 404");
    const unsafe = await fetch(`${base}/api/transport/subagents/child.1/transcript?projectId=p1&threadId=sess-1`);
    assert.equal(unsafe.status, 400, "a path-unsafe id is 400");
  });
});
