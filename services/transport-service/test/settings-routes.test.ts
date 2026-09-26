import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type Principal,
  type PrincipalResolver,
  type RuntimeAdapter,
} from "@science-studio/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return { runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} };
}

/** A fixed non-local principal, so the hosted write gate can be exercised. */
function fixedPrincipal(principal: Principal): PrincipalResolver {
  return { resolve: async () => principal };
}

function backend(
  settingsPath: string,
  principal: PrincipalResolver = new LocalPrincipalResolver(),
): Backend {
  return {
    principal,
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records: createInMemoryRecordStore(),
    settingsPath,
  };
}

async function withServer(
  settingsPath: string,
  fn: (base: string) => Promise<void>,
  principal?: PrincipalResolver,
): Promise<void> {
  const app = await createTransportService({ backend: backend(settingsPath, principal) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

const json = { "content-type": "application/json" };

test("PUT /api/settings merges and GET redacts the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-"));  try {
    await withServer(join(dir, "settings.json"), async (base) => {
      const put = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKey: "k" },
        }),
      });
      assert.equal(put.status, 200);
      const view = (await put.json()) as { model: Record<string, unknown> };
      assert.equal(view.model.provider, "ollama-local");
      assert.equal(view.model.apiKeyConfigured, true);
      assert.ok(!("apiKey" in view.model));

      const get = await fetch(`${base}/api/settings`);
      const fetched = (await get.json()) as { model: Record<string, unknown> };
      assert.equal(fetched.model.endpoint, "http://h/v1");
      assert.ok(!("apiKey" in fetched.model));

      await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { provider: "other" } }),
      });
      const kept = (await (await fetch(`${base}/api/settings`)).json()) as { model: { apiKeyConfigured: boolean } };
      assert.equal(kept.model.apiKeyConfigured, true, "an omitted key is kept");

      await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { apiKey: null } }),
      });
      const cleared = (await (await fetch(`${base}/api/settings`)).json()) as { model: { apiKeyConfigured: boolean } };
      assert.equal(cleared.model.apiKeyConfigured, false, "null clears the key");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PUT /api/settings rejects a bad body with 400", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-bad-"));
  try {
    await withServer(join(dir, "settings.json"), async (base) => {
      const res = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ model: { endpoint: "ftp://nope" } }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "model.endpoint must be an http(s) URL" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PUT /api/settings stores an MCP server and GET masks its secret values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-mcp-"));
  try {
    await withServer(join(dir, "settings.json"), async (base) => {
      const put = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          mcp: {
            servers: [
              {
                serverName: "github",
                transport: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
                env: { GITHUB_TOKEN: "secret-1" },
              },
            ],
          },
        }),
      });
      assert.equal(put.status, 200);
      const view = (await put.json()) as {
        mcp: { servers: Array<Record<string, unknown> & { envConfigured?: string[] }> };
      };
      assert.deepEqual(view.mcp.servers[0]?.envConfigured, ["GITHUB_TOKEN"]);
      assert.ok(!JSON.stringify(view).includes("secret-1"), "the response carries no secret value");

      // The write-only merge rule over HTTP: editing the command without
      // naming GITHUB_TOKEN keeps the stored value.
      const edited = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          mcp: { servers: [{ serverName: "github", transport: "stdio", command: "node" }] },
        }),
      });
      assert.equal(edited.status, 200);
      const stored = JSON.parse(
        await readFile(join(dir, "settings.json"), "utf8"),
      ) as { mcp: { servers: Array<{ command?: string; env?: Record<string, string> }> } };
      assert.equal(stored.mcp.servers[0]?.command, "node");
      assert.deepEqual(stored.mcp.servers[0]?.env, { GITHUB_TOKEN: "secret-1" });

      const bad = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ mcp: { servers: [{ serverName: "bad name", transport: "stdio", command: "x" }] } }),
      });
      assert.equal(bad.status, 400);
      assert.match(((await bad.json()) as { error: string }).error, /serverName/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-local non-manager principal can GET but not PUT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-settings-routes-hosted-"));
  const researcher: Principal = {
    id: "u-1",
    tenant: "t-1",
    displayName: "Researcher",
    roles: ["researcher"],
    local: false,
  };
  const manager: Principal = { ...researcher, roles: ["researcher", "manager"] };
  try {
    await withServer(
      join(dir, "researcher.json"),
      async (base) => {
        const get = await fetch(`${base}/api/settings`);
        assert.equal(get.status, 200, "GET stays available to any principal");
        const put = await fetch(`${base}/api/settings`, {
          method: "PUT",
          headers: json,
          body: JSON.stringify({ model: { provider: "p" } }),
        });
        assert.equal(put.status, 403, "a researcher cannot overwrite shared settings");
      },
      fixedPrincipal(researcher),
    );
    await withServer(
      join(dir, "manager.json"),
      async (base) => {
        const put = await fetch(`${base}/api/settings`, {
          method: "PUT",
          headers: json,
          body: JSON.stringify({ model: { provider: "p" } }),
        });
        assert.equal(put.status, 200, "a hosted manager may write");
      },
      fixedPrincipal(manager),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
