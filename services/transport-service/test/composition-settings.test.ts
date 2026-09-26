import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSettings, RuntimeAdapter, RuntimeInitOptions, RuntimePlugin } from "@science-studio/transport";
import { createBackend } from "../src/index.js";

function fakeAdapter(onInit?: (opts: RuntimeInitOptions) => void): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async (opts) => onInit?.(opts),
    run: async function* () {},
    abort: () => {},
  };
}

test("the settings file wins over the ambient launch env in the binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-composition-settings-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      model: { provider: "from-file", model: "file-model", endpoint: "http://file/v1", apiKey: "file-key" },
      plugins: {},
      agent: {},
    }),
  );
  let seen: NodeJS.ProcessEnv | null = null;
  const plugin: RuntimePlugin = {
    runtime: "fake",
    factory: {
      runtime: "fake",
      capabilities: {
        commandCatalog: false,
        remoteSettleWatch: false,
        tokenStreaming: false,
        approvals: false,
        hostedSandbox: false,
        perSessionCwd: false,
        subagents: false,
        subagentTranscript: false,
      },
      create: (): RuntimeAdapter => fakeAdapter(),
    },
    localBinding: (env) => {
      seen = { ...env };
      return { runtime: "fake", config: {} };
    },
  };
  try {
    const backend = await createBackend(
      {
        TRANSPORT_RUNTIME: "fake",
        RECORD_STORE: "memory",
        SS_SETTINGS_PATH: settingsPath,
        DSH_PROVIDER: "ambient",
        DSH_MODEL: "ambient-model",
      },
      [plugin],
    );
    const captured = seen as NodeJS.ProcessEnv | null;
    assert.ok(captured, "localBinding was called");
    assert.equal(captured.DSH_PROVIDER, "from-file");
    assert.equal(captured.DSH_MODEL, "file-model");
    assert.equal(captured.SS_MODEL_ENDPOINT, "http://file/v1");
    assert.equal(captured.SS_MODEL_API_KEY, "file-key");
    assert.equal(backend.settingsPath, settingsPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The MCP section is NOT boot-folded like the model route (docs/adr/0026):
 * `environmentFor` re-reads the settings file at each acquisition, so a child
 * launched after a save mounts the CURRENT list while a cached child keeps its
 * launch-time one.
 */
test("an MCP server list is re-read from the settings file at each environment acquisition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-composition-mcp-"));
  const settingsPath = join(dir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      model: {},
      plugins: {},
      agent: {},
      mcp: {
        servers: [
          { serverName: "github", transport: "stdio", enabled: true, command: "npx", env: { GITHUB_TOKEN: "a" } },
          { serverName: "old", transport: "stdio", enabled: true, command: "gone" },
        ],
      },
    }),
  );
  const inits: RuntimeInitOptions[] = [];
  const plugin: RuntimePlugin = {
    runtime: "fake",
    factory: {
      runtime: "fake",
      capabilities: {
        commandCatalog: false,
        remoteSettleWatch: false,
        tokenStreaming: false,
        approvals: false,
        hostedSandbox: false,
        perSessionCwd: false,
        subagents: false,
        subagentTranscript: false,
      },
      create: () =>
        fakeAdapter((opts) => {
          inits.push(opts);
        }),
    },
    localBinding: () => ({ runtime: "fake", config: {} }),
  };
  const local: import("@science-studio/transport").Principal = {
    id: "u-local",
    tenant: "t",
    displayName: "Local",
    roles: [],
    local: true,
  };
  try {
    const backend = await createBackend(
      { TRANSPORT_RUNTIME: "fake", RECORD_STORE: "memory", SS_SETTINGS_PATH: settingsPath },
      [plugin],
    );
    await backend.environments.acquire(local, "project-default", "main");
    assert.equal(inits.length, 1);
    assert.deepEqual(
      (inits[0]?.mcpServers ?? []).map((s) => s.serverName),
      ["github", "old"],
    );

    // A save drops `old` and adds `web`. A CACHED environment keeps its
    // launch-time list (init is not re-run); only a fresh acquisition sees the
    // change — the restart-to-apply rule.
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: {},
        plugins: {},
        agent: {},
        mcp: {
          servers: [
            { serverName: "github", transport: "stdio", enabled: true, command: "node" },
            { serverName: "web", transport: "streamable-http", enabled: true, url: "http://h/mcp" },
          ],
        },
      }),
    );
    await backend.environments.acquire(local, "project-default", "main");
    assert.equal(inits.length, 1, "the cached environment did not re-init");

    await backend.environments.release?.(local, "project-default", "main");
    await backend.environments.acquire(local, "project-default", "main");
    assert.equal(inits.length, 2);
    assert.deepEqual(
      (inits[1]?.mcpServers ?? []).map((s) => s.serverName),
      ["github", "web"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
