import { test } from "node:test";
import assert from "node:assert/strict";
import * as seams from "../src/seams.js";
import * as root from "../src/index.js";
import type { SubagentRun } from "../src/seams.js";
import type {
  McpStdioServerSettings,
  McpSettingsPatch,
  ModelSettings,
  ModelSettingsPatch,
  RuntimeSettings,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "../src/settings.js";

/**
 * The seam split is a boundary, not a convention: `./seams` carries the contract
 * (interfaces + their error classes + limit constants) while the package root
 * additionally carries the shared kit and the pure single-user defaults.
 * These tests pin both directions so the boundary cannot silently rot.
 */
const CONTRACT_VALUES = [
  "DEFAULT_MAX_UPLOAD_BYTES",
  "DEFAULT_QUOTA_BYTES",
  "MCP_SERVER_NAME_GRAMMAR",
  "WorkspaceNotFoundError",
  "WorkspacePathError",
  "WorkspaceEscapeError",
  "WorkspaceUnavailableError",
  "FileTooLargeError",
  "RuntimeBindingError",
] as const;

const NON_CONTRACT_NAMES = [
  // Kit
  "RunFlow",
  "SessionRuntime",
  "foldState",
  "sameMessages",
  "sameConversation",
  "textOutput",
  "mergeToolResult",
  "renderAttachments",
  "promptWithAttachments",
  "userMessageParts",
  "parseWorkspaceMentions",
  "attachmentsFromMentions",
  "isCommandText",
  "bindingString",
  "bindingOptionalString",
  // Pure single-user defaults
  "LocalPrincipalResolver",
  "LocalEnvironmentProvider",
  "NullWorkspace",
  "NoopQuotaPolicy",
] as const;

test("the seams entry exposes the contract surface", () => {
  for (const name of CONTRACT_VALUES) {
    assert.ok(name in seams, `seams should export ${name}`);
  }
});

test("the seams entry exposes no kit and no defaults", () => {
  for (const name of NON_CONTRACT_NAMES) {
    assert.ok(!(name in seams), `seams must not export ${name}`);
  }
});

test("the package root still carries kit and defaults on top of the contract", () => {
  for (const name of [...CONTRACT_VALUES, ...NON_CONTRACT_NAMES]) {
    assert.ok(name in root, `root should export ${name}`);
  }
});

/**
 * The settings contract is TYPE-ONLY, so the value-space loops above cannot see
 * it. This block is the compile-time pin: each of the five types must be
 * importable from `../src/settings.js` and usable to build a real value.
 */
test("the settings contract types are importable and usable", () => {
  const model: ModelSettings = { provider: "ollama-local", model: "qwen3.8:latest", apiKey: "k" };
  const modelPatch: ModelSettingsPatch = { provider: "ollama-local", apiKey: null };
  const mcpServer: McpStdioServerSettings = {
    serverName: "github",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "secret" },
  };
  const mcpPatch: McpSettingsPatch = { servers: [{ serverName: "web", transport: "streamable-http", url: "http://localhost:3000/mcp", headers: { Authorization: null } }] };
  const settings: RuntimeSettings = { model, plugins: {}, agent: {}, mcp: { servers: [mcpServer] } };
  const patch: RuntimeSettingsPatch = { model: modelPatch, plugins: { a: 1 }, mcp: mcpPatch };
  const view: RuntimeSettingsView = {
    model: { provider: model.provider, apiKeyConfigured: true },
    plugins: {},
    agent: {},
    subagents: {},
    thread: {},
    hpc: { endpoints: [] },
    mcp: {
      servers: [
        {
          serverName: mcpServer.serverName,
          transport: "stdio",
          enabled: true,
          command: mcpServer.command,
          args: mcpServer.args,
          envConfigured: Object.keys(mcpServer.env ?? {}),
        },
      ],
    },
    runtime: "dsh",
    settingsPath: "/tmp/settings.json",
  };
  assert.equal(settings.model.provider, "ollama-local");
  assert.equal(patch.model?.apiKey ?? null, null);
  assert.equal(view.model.apiKeyConfigured, true);
  assert.equal(view.settingsPath, "/tmp/settings.json");
  assert.deepEqual(view.mcp.servers[0]?.transport === "stdio" ? view.mcp.servers[0].envConfigured : [], ["GITHUB_TOKEN"]);
});

test("the SubagentRun view type is importable and usable", () => {
  const run: SubagentRun = {
    id: "child-1",
    parentId: "sess-1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  };
  assert.equal(run.status, "running");
});
