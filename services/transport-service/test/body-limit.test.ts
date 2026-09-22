import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
  type StateDelta,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

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

test("a send whose claimed state exceeds Fastify's 1 MiB default is admitted", async () => {
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* (): AsyncIterable<StateDelta> {},
    abort: () => {},
  };

  await withServer(adapter, async (base) => {
    // Every send carries the client's WHOLE claimed transcript in `state`
    // (assistant-ui round-trips `agentStateRef.current`), so a grown
    // conversation serializes to megabytes — Fastify's default 1 MiB
    // bodyLimit must not reject it with 413 before the handler runs.
    const messages: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      messages[`m${i}`] = {
        id: `m${i}`,
        role: "assistant",
        parts: [{ type: "text", text: "x".repeat(20_000) }],
      };
    }
    const body = { commands: [], state: { status: "idle", messages } };
    assert.ok(
      JSON.stringify(body).length > 1024 * 1024,
      "the fixture must exceed the 1 MiB default",
    );

    const res = await post(base, "/api/transport", body);
    assert.equal(
      res.status,
      200,
      "the transport route must not answer 413 for a transcript-sized body",
    );
    assert.match(await res.text(), /\[DONE\]/);
  });
});

test("TRANSPORT_MAX_BODY_BYTES still caps a JSON body when set", async () => {
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* (): AsyncIterable<StateDelta> {},
    abort: () => {},
  };

  process.env.TRANSPORT_MAX_BODY_BYTES = "1048576"; // 1 MiB, the Fastify default
  try {
    await withServer(adapter, async (base) => {
      const res = await post(base, "/api/transport", {
        commands: [],
        state: { status: "idle", messages: {} },
        pad: "x".repeat(2 * 1024 * 1024),
      });
      assert.equal(res.status, 413, "the configured cap must still be enforced");
    });
  } finally {
    delete process.env.TRANSPORT_MAX_BODY_BYTES;
  }
});
