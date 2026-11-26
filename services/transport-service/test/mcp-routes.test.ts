import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInMemoryRecordStore, type RecordStore } from "@gps/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type McpServerSettings,
  type PrincipalResolver,
  type RuntimeAdapter,
} from "@gps/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import type { McpProber, McpProbeResult } from "../src/mcp/probe.js";

const json = { "content-type": "application/json" };

function adapter(): RuntimeAdapter {
  return { runtime: "dsh", init: async () => {}, run: async function* () {}, abort: () => {} };
}

const capabilities = {
  commandCatalog: false,
  remoteSettleWatch: false,
  tokenStreaming: false,
  approvals: false,
  hostedSandbox: false,
  perSessionCwd: true,
  subagents: false,
  subagentTranscript: false,
  mcp: true,
};

async function fixture(options: {
  records?: RecordStore;
  principal?: PrincipalResolver;
  probe?: McpProber;
  settingsPath: string;
}): Promise<Backend> {
  return {
    principal: options.principal ?? new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    cors: { origin: true },
    records: options.records ?? createInMemoryRecordStore(),
    settingsPath: options.settingsPath,
    capabilities,
    ...(options.probe ? { mcpProbe: options.probe } : {}),
  };
}

async function withServer(
  backend: Backend,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

async function projects(): Promise<RecordStore> {
  const records = createInMemoryRecordStore();
  const createdAt = new Date().toISOString();
  await records.createProject({ id: "proj-a", name: "A", createdAt });
  await records.createProject({ id: "proj-b", name: "B", createdAt });
  return records;
}

async function create(
  base: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/api/mcp/servers`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });
}

test("MCP CRUD keeps secrets write-only and filters project rows per Project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-mcp-routes-"));
  const settingsPath = join(dir, "settings.json");
  try {
    await withServer(await fixture({ records: await projects(), settingsPath }), async (base) => {
      const global = await create(base, {
        id: "github",
        scope: "global",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        env: { GITHUB_TOKEN: "s3cret" },
      });
      assert.equal(global.status, 201);
      const globalBody = (await global.json()) as { server: { envKeys: string[] } };
      assert.deepEqual(globalBody.server.envKeys, ["GITHUB_TOKEN"]);
      assert.equal(JSON.stringify(globalBody).includes("s3cret"), false);

      const project = await create(base, {
        id: "lab",
        scope: "project",
        projectId: "proj-a",
        transport: "stdio",
        command: "lab-server",
        env: { LAB_TOKEN: "lab-secret" },
      });
      assert.equal(project.status, 201);

      const a = (await (await fetch(`${base}/api/mcp/servers?projectId=proj-a`)).json()) as {
        servers: { id: string }[];
        available: boolean;
      };
      assert.equal(a.available, true);
      assert.deepEqual(a.servers.map((server) => server.id), ["github", "lab"]);

      const b = (await (await fetch(`${base}/api/mcp/servers?projectId=proj-b`)).json()) as {
        servers: { id: string }[];
      };
      assert.deepEqual(b.servers.map((server) => server.id), ["github"]);

      // Editing without env preserves the stored secret.
      const update = await fetch(`${base}/api/mcp/servers/github`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ scope: "global", transport: "stdio", command: "npx-next" }),
      });
      assert.equal(update.status, 200);
      let stored = JSON.parse(await readFile(settingsPath, "utf8")) as {
        mcp: { servers: McpServerSettings[] };
      };
      assert.equal(stored.mcp.servers.find((server) => server.id === "github")?.env?.GITHUB_TOKEN, "s3cret");

      // A per-key secret patch removes one and adds another.
      const secretUpdate = await fetch(`${base}/api/mcp/servers/github`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          scope: "global",
          transport: "stdio",
          command: "npx-next",
          env: { GITHUB_TOKEN: null, NEW_TOKEN: "new" },
        }),
      });
      assert.equal(secretUpdate.status, 200);
      stored = JSON.parse(await readFile(settingsPath, "utf8")) as {
        mcp: { servers: McpServerSettings[] };
      };
      assert.deepEqual(stored.mcp.servers.find((server) => server.id === "github")?.env, {
        NEW_TOKEN: "new",
      });

      const removed = await fetch(`${base}/api/mcp/servers/lab`, { method: "DELETE" });
      assert.equal(removed.status, 200);
      const after = (await (await fetch(`${base}/api/mcp/servers?projectId=proj-a`)).json()) as {
        servers: { id: string }[];
      };
      assert.deepEqual(after.servers.map((server) => server.id), ["github"]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP writes validate the Project and the manager gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-mcp-routes-"));
  const settingsPath = join(dir, "settings.json");
  try {
    const records = await projects();
    await withServer(await fixture({ records, settingsPath }), async (base) => {
      const unknown = await create(base, {
        id: "lab",
        scope: "project",
        projectId: "missing",
        transport: "stdio",
        command: "lab",
      });
      assert.equal(unknown.status, 400);

      const unsafe = await create(base, {
        id: "lab",
        scope: "project",
        projectId: "../escape",
        transport: "stdio",
        command: "lab",
      });
      assert.equal(unsafe.status, 400);
    });

    const researcher: PrincipalResolver = {
      resolve: async () => ({
        id: "r",
        tenant: "r",
        displayName: "Researcher",
        roles: ["researcher"],
        local: false,
      }),
    };
    await withServer(await fixture({ records, settingsPath, principal: researcher }), async (base) => {
      const read = await fetch(`${base}/api/mcp/servers`);
      assert.equal(read.status, 200);
      const denied = await create(base, {
        id: "lab",
        scope: "global",
        transport: "stdio",
        command: "lab",
      });
      assert.equal(denied.status, 403);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Test connection probes a draft and reuses stored credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-mcp-routes-"));
  const settingsPath = join(dir, "settings.json");
  try {
    const seen: McpServerSettings[] = [];
    const result: McpProbeResult = {
      ok: true,
      serverInfo: { name: "fake", version: "1" },
      toolCount: 2,
      tools: [{ name: "echo" }, { name: "search" }],
    };
    const probe: McpProber = {
      probe: async (server) => {
        seen.push(server);
        return result;
      },
    };
    await withServer(await fixture({ records: await projects(), settingsPath, probe }), async (base) => {
      await create(base, {
        id: "github",
        scope: "global",
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "s3cret" },
      });

      const response = await fetch(`${base}/api/mcp/probe`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          id: "github",
          projectId: "proj-a",
          worktreeId: "main",
          server: { scope: "global", transport: "stdio", command: "npx" },
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), result);
      assert.equal(seen[0]?.env?.GITHUB_TOKEN, "s3cret");

      const draft = await fetch(`${base}/api/mcp/probe`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          projectId: "proj-a",
          server: {
            id: "echo",
            scope: "global",
            transport: "streamable-http",
            url: "http://localhost:9999/mcp",
          },
        }),
      });
      assert.equal(draft.status, 200);
      assert.equal(seen[1]?.id, "echo");
      assert.equal(seen[1]?.transport, "streamable-http");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a Project drops its project-scoped MCP rows only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-mcp-routes-"));
  const settingsPath = join(dir, "settings.json");
  try {
    const records = await projects();
    await withServer(await fixture({ records, settingsPath }), async (base) => {
      for (const body of [
        { id: "global", scope: "global", transport: "stdio", command: "g" },
        { id: "a", scope: "project", projectId: "proj-a", transport: "stdio", command: "a" },
        { id: "b", scope: "project", projectId: "proj-b", transport: "stdio", command: "b" },
      ]) {
        assert.equal((await create(base, body)).status, 201);
      }
      const deleted = await fetch(`${base}/api/projects/proj-a/delete`, { method: "POST" });
      assert.equal(deleted.status, 200);
      const stored = JSON.parse(await readFile(settingsPath, "utf8")) as {
        mcp: { servers: McpServerSettings[] };
      };
      assert.deepEqual(stored.mcp.servers.map((server) => server.id), ["global", "b"]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
