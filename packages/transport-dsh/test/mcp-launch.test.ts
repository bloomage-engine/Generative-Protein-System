import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSettings } from "@gps/transport";
import { DshRuntimeAdapter } from "../src/adapter.js";
import type { DshClientLaunchOptions, DshTurnClient } from "../src/client.js";
import { MCP_CONFIG_ENV, dshMcpConfigs, writeMcpPatch } from "../src/mcp-patch.js";

const META = { id: "drought-screen", name: "Drought", createdAt: "2026-09-01T00:00:00.000Z" };
const noRecordStore = { addRun: async () => {} };

const servers: McpServerSettings[] = [
  {
    id: "global",
    scope: "global",
    enabled: true,
    transport: "stdio",
    command: "global-server",
    env: { GLOBAL_TOKEN: "global-secret" },
  },
  {
    id: "mine",
    scope: "project",
    projectId: META.id,
    enabled: true,
    transport: "stdio",
    command: "mine-server",
    env: { MINE_TOKEN: "mine-secret" },
  },
  {
    id: "other",
    scope: "project",
    projectId: "another-project",
    enabled: true,
    transport: "stdio",
    command: "other-server",
    env: { OTHER_TOKEN: "other-secret" },
  },
  {
    id: "off",
    scope: "global",
    enabled: false,
    transport: "stdio",
    command: "off-server",
  },
];

test("writeMcpPatch emits one plugin insert per server and no credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-patch-"));
  try {
    const file = await writeMcpPatch({ dir, configs: dshMcpConfigs(servers.slice(0, 2)) });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: gps-mcp-0/);
    assert.match(patch, /id: gps-mcp-1/);
    assert.match(patch, /name: "@deepseek-ai\/dsh-mcp-client"/);
    assert.match(patch, /GPS_MCP_SECRET_CONFIG/);
    assert.equal(patch.includes("global-secret"), false);
    assert.equal(patch.includes("mine-secret"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function mounted(opts: {
  project?: { id: string; name: string; createdAt: string };
  mcpServers?: McpServerSettings[];
}): Promise<{ patches: string[]; env: NodeJS.ProcessEnv | undefined }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-launch-"));
  let seen: DshClientLaunchOptions | undefined;
  const adapter = new DshRuntimeAdapter({
    createClient: (options): DshTurnClient => {
      seen = options;
      return { start: async () => {}, close: async () => {}, runTurn: async () => {} };
    },
    bridgeDir: dir,
    bridgePluginPath: "/opt/ss/bridge-plugin.js",
    projectPluginPath: "/opt/ss/project-plugin.js",
    cronPluginPath: "/opt/ss/cron-plugin.js",
    subagentPluginPath: "/opt/ss/subagent-plugin.js",
    hpcPluginPath: "/opt/ss/hpc-plugin.js",
    worktreePluginPath: "/opt/ss/worktree-plugin.js",
  });
  try {
    await adapter.init({
      binding: { runtime: "dsh", config: { mcpServers: opts.mcpServers ?? servers } },
      recordStore: noRecordStore,
      ...(opts.project ? { project: opts.project } : {}),
    });
    const patches = await Promise.all(
      (seen?.patches ?? []).map((file) => readFile(file, "utf8")),
    );
    return { patches, env: seen?.env };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a Project child mounts only global rows plus its own", async () => {
  const { patches, env } = await mounted({ project: META });
  const mcp = patches.find((patch) => patch.includes("@deepseek-ai/dsh-mcp-client"));
  assert.ok(mcp, "MCP patch was mounted");
  assert.match(mcp, /gps-mcp-0/);
  assert.match(mcp, /gps-mcp-1/);
  assert.equal(mcp.includes("gps-mcp-2"), false);

  const parsed = JSON.parse(env?.[MCP_CONFIG_ENV] ?? "[]") as {
    serverName: string;
    env?: Record<string, string>;
  }[];
  assert.deepEqual(parsed.map((server) => server.serverName), ["global", "mine"]);
  assert.equal(parsed[0]?.env?.GLOBAL_TOKEN, "global-secret");
});

test("a standalone child (no Project) mounts only global rows", async () => {
  const { patches, env } = await mounted({});
  const mcp = patches.find((patch) => patch.includes("@deepseek-ai/dsh-mcp-client"));
  assert.ok(mcp);
  assert.equal(mcp.includes("gps-mcp-1"), false);
  const parsed = JSON.parse(env?.[MCP_CONFIG_ENV] ?? "[]") as { serverName: string }[];
  assert.deepEqual(parsed.map((server) => server.serverName), ["global"]);
});

test("no applicable servers mounts no MCP patch and sets no env", async () => {
  const { patches, env } = await mounted({
    project: { id: "new-project", name: "New", createdAt: META.createdAt },
    mcpServers: [],
  });
  const mcp = patches.find((patch) => patch.includes("@deepseek-ai/dsh-mcp-client"));
  assert.equal(mcp, undefined);
  assert.equal(env?.[MCP_CONFIG_ENV], undefined);
});
