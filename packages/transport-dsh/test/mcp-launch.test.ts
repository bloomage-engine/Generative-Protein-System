import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSettings, RecordStoreLike } from "@science-studio/transport";
import { writeMcpPatch } from "../src/bridge.js";
import { executeDshCommand } from "../src/commands.js";
import { DshRuntimeAdapter, type DshTurnClient } from "../src/index.js";

const GITHUB: McpServerSettings = {
  serverName: "github",
  transport: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "literal-secret" },
};

const WEB: McpServerSettings = {
  serverName: "web",
  transport: "streamable-http",
  url: "http://localhost:3000/mcp",
  headers: { Authorization: "Bearer t0ken" },
};

test("writeMcpPatch inserts one @deepseek-ai/dsh-mcp-client row per server, config JSON verbatim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mcp-launch-"));
  try {
    const file = await writeMcpPatch({ dir, servers: [GITHUB, WEB] });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    // The row name is the BARE package specifier (it resolves from the dsh CLI's
    // install closure — unlike the sibling patches' file: URLs), and the row id
    // carries the serverName.
    assert.match(patch, /id: science-studio-mcp-github\n\s+name: "@deepseek-ai\/dsh-mcp-client"/);
    assert.match(patch, /id: science-studio-mcp-web\n\s+name: "@deepseek-ai\/dsh-mcp-client"/);
    // Config keeps the plugin's own fields with their secret values (the patch
    // file is 0600), and NEVER the storage-only `enabled` flag.
    assert.match(
      patch,
      /"serverName":"github","transport":"stdio","command":"npx","args":\["-y","@modelcontextprotocol\/server-github"\],"env":\{"GITHUB_TOKEN":"literal-secret"\}/,
    );
    assert.match(
      patch,
      /"serverName":"web","transport":"streamable-http","url":"http:\/\/localhost:3000\/mcp","headers":\{"Authorization":"Bearer t0ken"\}/,
    );
    assert.doesNotMatch(patch, /enabled/);
    assert.doesNotMatch(patch, /file:\/\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch patches land owner-only: the shared dir is 0700 and every patch file 0600", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "dsh-mcp-modes-")), "bridge");
  try {
    const file = await writeMcpPatch({ dir, servers: [GITHUB] });
    assert.equal(((await stat(dir)).mode & 0o777).toString(8), "700");
    assert.equal(((await stat(file)).mode & 0o777).toString(8), "600");
  } finally {
    await rm(join(dir, ".."), { recursive: true, force: true });
  }
});

const emptyStore: RecordStoreLike = { addRun: async () => {} };

function idleClient(): DshTurnClient {
  return {
    async start(): Promise<void> {},
    async close(): Promise<void> {},
    async runTurn(): Promise<void> {},
  };
}

/** Boot an adapter with the given MCP list and return the patch paths it assembled. */
async function initPatches(mcpServers: McpServerSettings[] | undefined, dir: string): Promise<string[]> {
  let patches: string[] = [];
  const adapter = new DshRuntimeAdapter({
    createClient: (options) => {
      patches = options.patches ?? [];
      return idleClient();
    },
    bridgeDir: dir,
    transcriptDir: dir,
  });
  await adapter.init({
    binding: { runtime: "dsh", config: {} },
    recordStore: emptyStore,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
  adapter.abort();
  return patches;
}

test("init mounts the MCP patch for the deployment list — enabled rows only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mount-"));
  try {
    const patches = await initPatches([GITHUB, { ...WEB, enabled: false }], dir);
    const file = patches.find((p) => p.includes("mcp-"));
    assert.ok(file, "an MCP launch patch is mounted");
    const patch = await readFile(file, "utf8");
    assert.match(patch, /science-studio-mcp-github/);
    assert.doesNotMatch(patch, /science-studio-mcp-web/, "a disabled server is not mounted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no MCP list (or none enabled) writes no patch at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-none-"));
  try {
    for (const servers of [undefined, [], [{ ...GITHUB, enabled: false }]]) {
      const patches = await initPatches(servers, dir);
      assert.ok(
        !patches.some((p) => p.includes("mcp-")),
        `no mcp patch for ${JSON.stringify(servers)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/status reports the MCP servers this child mounts (a patch fact, not connectivity)", () => {
  const mounted = executeDshCommand("/status", {
    sessionKey: "sess-1",
    profile: "sdk",
    provider: "ollama-local",
    model: "qwen3.8:latest",
    cwd: "/projects/p1",
    harnessSessionId: null,
    mcpServers: [GITHUB, WEB],
  });
  assert.match(mounted.reply, /- mcp: `github` \(stdio\), `web` \(streamable-http\)/);
  // The reply never carries secret VALUES — names and transport only.
  assert.doesNotMatch(mounted.reply, /literal-secret|t0ken/);

  const bare = executeDshCommand("/status", {
    sessionKey: "sess-1",
    profile: "sdk",
    provider: "ollama-local",
    model: "qwen3.8:latest",
    cwd: "/projects/p1",
    harnessSessionId: null,
  });
  assert.match(bare.reply, /- mcp: none mounted/);
});
