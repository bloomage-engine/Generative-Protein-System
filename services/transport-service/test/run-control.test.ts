import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
  type StateDelta,
} from "@gps/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withServer(
  adapter: RuntimeAdapter,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter, workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PROBE = { commands: [], state: { status: "idle", messages: {} } };

test("a second run for the same session is refused with 409", async () => {
  const entered = deferred();
  const release = deferred();
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* (): AsyncIterable<StateDelta> {
      entered.resolve();
      await release.promise;
    },
    abort: () => {},
  };

  await withServer(adapter, async (base) => {
    const first = post(base, "/api/transport", PROBE);
    await entered.promise; // the first run is now in flight

    const second = await post(base, "/api/transport", PROBE);
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.match(body.error, /already in flight/);

    release.resolve();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    const stream = await firstResponse.text();
    assert.match(stream, /\[DONE\]/, "the first run must still terminate normally");

    // The lock is released, so a later run is admitted.
    const third = await post(base, "/api/transport", PROBE);
    assert.equal(third.status, 200);
    await third.text();
  });
});

test("POST /api/transport/abort reaches the adapter", async () => {
  const seen: { reason?: string } = {};
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: (reason?: string) => {
      seen.reason = reason;
    },
  };

  await withServer(adapter, async (base) => {
    const res = await post(base, "/api/transport/abort", { reason: "user cancelled" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    assert.equal(seen.reason, "user cancelled");
  });
});

test("POST /api/transport/approve reaches an adapter that supports approvals", async () => {
  const seen: { id?: string; decision?: string } = {};
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
    approve: (id: string, decision: "approve" | "reject") => {
      seen.id = id;
      seen.decision = decision;
    },
  };

  await withServer(adapter, async (base) => {
    const res = await post(base, "/api/transport/approve", {
      approvalId: "ap-1",
      decision: "reject",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { id: "ap-1", decision: "reject" });
  });
});

test("approve answers 501 for a runtime with no approval surface, 400 for a bad body", async () => {
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
  };

  await withServer(adapter, async (base) => {
    const unsupported = await post(base, "/api/transport/approve", {
      approvalId: "ap-1",
      decision: "approve",
    });
    assert.equal(unsupported.status, 501);

    const bad = await post(base, "/api/transport/approve", { approvalId: "ap-1" });
    assert.equal(bad.status, 400);
  });
});
