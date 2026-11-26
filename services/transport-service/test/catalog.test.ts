import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type {
  CommandDescriptor,
  RuntimeAdapter,
  SessionState,
  TransportCommand,
} from "@gps/transport";
import { createTransportService } from "../src/index.js";

/**
 * The `/api/transport/commands` catalog route. A runtime without the surface
 * answers a successful empty catalog; a transient adapter failure propagates as
 * a 5xx so the composer's own hook owns the degrade (docs/adr/0021).
 */

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

const COMMAND: CommandDescriptor = {
  id: "status",
  label: "Status",
  description: "Show status",
  invocationText: "/status",
};

test("GET /api/transport/commands returns the adapter's catalog", async () => {
  const adapter: RuntimeAdapter = { ...emptyAdapter, listCommands: async () => [COMMAND] };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/commands?projectId=p1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commands: [COMMAND] });
  });
});

test("GET /api/transport/commands answers empty when the runtime has no surface", async () => {
  await withAdapter(emptyAdapter, async (base) => {
    const res = await fetch(`${base}/api/transport/commands?projectId=p1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commands: [] });
  });
});

test("GET /api/transport/commands propagates an adapter failure", async () => {
  const adapter: RuntimeAdapter = {
    ...emptyAdapter,
    listCommands: async () => {
      throw new Error("boom");
    },
  };
  await withAdapter(adapter, async (base) => {
    const res = await fetch(`${base}/api/transport/commands?projectId=p1`);
    assert.equal(res.status, 500);
  });
});