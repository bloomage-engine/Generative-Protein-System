import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter, RuntimePlugin } from "@science-studio/transport";
import { createBackend } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return { runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} };
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
