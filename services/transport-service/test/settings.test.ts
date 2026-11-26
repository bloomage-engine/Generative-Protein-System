import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettingsToEnv,
  emptySettings,
  loadSettings,
  mergeSettings,
  parseSettingsPatch,
  resolveSettingsPath,
  saveSettings,
  viewOf,
} from "../src/settings.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ss-settings-"));
}

function errorOf(result: ReturnType<typeof parseSettingsPatch>): string {
  if (!("error" in result)) throw new Error("expected a settings patch error");
  return result.error;
}

test("resolveSettingsPath prefers SS_SETTINGS_PATH, else XDG_DATA_HOME", () => {
  assert.equal(resolveSettingsPath({ SS_SETTINGS_PATH: "/tmp/x.json" }), "/tmp/x.json");
  assert.equal(
    resolveSettingsPath({ XDG_DATA_HOME: "/data" }),
    join("/data", "science-studio", "settings.json"),
  );
});

test("loadSettings returns defaults for an absent or malformed file", async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await loadSettings(join(dir, "nope.json")), emptySettings());
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    assert.deepEqual(await loadSettings(bad), emptySettings());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSettings writes a 0600 file that loadSettings round-trips", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "nested", "settings.json");
    await saveSettings(path, { model: { provider: "ollama-local", apiKey: "secret" }, plugins: {}, agent: {} });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const loaded = await loadSettings(path);
    assert.equal(loaded.model.provider, "ollama-local");
    assert.equal(loaded.model.apiKey, "secret");
    assert.match(await readFile(path, "utf8"), /secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSettings applies the absent/null/string apiKey rule", () => {
  const base = { model: { provider: "p", apiKey: "old" }, plugins: {}, agent: {} };
  assert.equal(mergeSettings(base, { model: { model: "m" } }).model.apiKey, "old");
  assert.equal(mergeSettings(base, { model: { apiKey: null } }).model.apiKey, undefined);
  assert.equal(mergeSettings(base, { model: { apiKey: "" } }).model.apiKey, "");
  assert.equal(mergeSettings(base, { model: { apiKey: "new" } }).model.apiKey, "new");
  assert.equal(mergeSettings(base, { model: { provider: "q" } }).model.provider, "q");
});

test("mergeSettings treats an empty provider/model/endpoint as a clear", () => {
  const base = {
    model: { provider: "p", model: "m", endpoint: "http://x/v1", apiKey: "old" },
    plugins: {},
    agent: {},
  };
  const cleared = mergeSettings(base, { model: { provider: "", model: "", endpoint: "" } });
  assert.equal(cleared.model.provider, undefined);
  assert.equal(cleared.model.model, undefined);
  assert.equal(cleared.model.endpoint, undefined);
  assert.equal(cleared.model.apiKey, "old", "clearing the route leaves the key alone");
});

test("viewOf redacts the key and reports the configured flag", () => {
  const view = viewOf(
    { model: { provider: "p", apiKey: "secret" }, plugins: {}, agent: {} },
    "/tmp/settings.json",
    { TRANSPORT_RUNTIME: "dsh" },
  );
  assert.equal(view.model.apiKeyConfigured, true);
  assert.equal(view.runtime, "dsh");
  assert.equal(view.settingsPath, "/tmp/settings.json");
  assert.deepEqual(view.model, { provider: "p", apiKeyConfigured: true });
});

test("applySettingsToEnv layers settings over env without mutating the input", () => {
  const env = { DSH_PROVIDER: "ambient", DSH_MODEL: "ambient-model", KEEP: "1" };
  const next = applySettingsToEnv(env, {
    model: { provider: "from-file", model: "m1", endpoint: "http://x/v1", apiKey: "k" },
    plugins: {},
    agent: {},
  });
  assert.equal(next.DSH_PROVIDER, "from-file");
  assert.equal(next.DSH_MODEL, "m1");
  assert.equal(next.SS_MODEL_ENDPOINT, "http://x/v1");
  assert.equal(next.SS_MODEL_API_KEY, "k");
  assert.equal(next.KEEP, "1");
  assert.equal(env.DSH_PROVIDER, "ambient", "the input env is not mutated");
  assert.equal(applySettingsToEnv(env, emptySettings()).DSH_PROVIDER, "ambient");
});

test("parseSettingsPatch validates and normalizes", () => {
  assert.equal(errorOf(parseSettingsPatch("nope")), "settings body must be a JSON object");
  assert.equal(errorOf(parseSettingsPatch({ model: 3 })), "model must be an object");
  assert.equal(errorOf(parseSettingsPatch({ model: { provider: 3 } })), "model.provider must be a string");
  assert.equal(
    errorOf(parseSettingsPatch({ model: { endpoint: "ftp://x" } })),
    "model.endpoint must be an http(s) URL",
  );
  assert.equal(errorOf(parseSettingsPatch({ model: { apiKey: 3 } })), "model.apiKey must be a string or null");
  assert.equal(errorOf(parseSettingsPatch({ plugins: [] })), "plugins must be an object");
  assert.equal(errorOf(parseSettingsPatch({ agent: "x" })), "agent must be an object");
  assert.deepEqual(parseSettingsPatch({ model: { provider: "" }, plugins: { a: 1 } }), {
    patch: { model: { provider: "" }, plugins: { a: 1 } },
  });
});

test("viewOf reports the subagents section (empty when unset)", () => {
  const view = viewOf({ model: {}, plugins: {}, agent: {} }, "/tmp/s.json", {});
  assert.deepEqual(view.subagents, {});
});

test("mergeSettings sets and clears subagents.visibleWindowHours", () => {
  const base = { model: {}, plugins: {}, agent: {} };
  const withHour = mergeSettings(base, { subagents: { visibleWindowHours: 48 } });
  assert.equal(withHour.subagents?.visibleWindowHours, 48);
  const cleared = mergeSettings(withHour, { subagents: { visibleWindowHours: null } });
  assert.equal(cleared.subagents?.visibleWindowHours, undefined);
  // An absent subagents patch leaves the stored value alone.
  const untouched = mergeSettings(withHour, {});
  assert.equal(untouched.subagents?.visibleWindowHours, 48);
});

test("parseSettingsPatch validates subagents.visibleWindowHours", () => {
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: 48 } }), {
    patch: { subagents: { visibleWindowHours: 48 } },
  });
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: 1 } }), {
    patch: { subagents: { visibleWindowHours: 1 } },
  });
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: 720 } }), {
    patch: { subagents: { visibleWindowHours: 720 } },
  });
  assert.deepEqual(parseSettingsPatch({ subagents: { visibleWindowHours: null } }), {
    patch: { subagents: { visibleWindowHours: null } },
  });
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: 0 } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: 1000 } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: 1.5 } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(
    errorOf(parseSettingsPatch({ subagents: { visibleWindowHours: "x" } })),
    "subagents.visibleWindowHours must be an integer between 1 and 720",
  );
  assert.equal(errorOf(parseSettingsPatch({ subagents: [] })), "subagents must be an object");
});

test("loadSettings drops invalid MCP rows and keeps valid ones", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        model: {},
        plugins: {},
        agent: {},
        mcp: {
          servers: [
            { id: "ok", scope: "global", enabled: true, transport: "stdio", command: "srv" },
            { id: "bad id", scope: "global", enabled: true, transport: "stdio", command: "srv" },
            { id: "ok", scope: "global", enabled: true, transport: "stdio", command: "dup" },
          ],
        },
      }),
    );
    const loaded = await loadSettings(path);
    assert.deepEqual(loaded.mcp?.servers.map((server) => server.id), ["ok"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applySettingsToEnv carries the enabled MCP catalog in the secret env", () => {
  const next = applySettingsToEnv(
    { SS_MCP_SECRET_CONFIG: "stale" },
    {
      model: {},
      plugins: {},
      agent: {},
      mcp: {
        servers: [
          {
            id: "a",
            scope: "global",
            enabled: true,
            transport: "stdio",
            command: "a",
            env: { TOKEN: "x" },
          },
          {
            id: "b",
            scope: "project",
            projectId: "p",
            enabled: false,
            transport: "stdio",
            command: "b",
          },
        ],
      },
    },
  );
  const parsed = JSON.parse(next.SS_MCP_SECRET_CONFIG ?? "[]") as { id: string }[];
  assert.deepEqual(parsed.map((server) => server.id), ["a"]);
  assert.equal(
    applySettingsToEnv({ SS_MCP_SECRET_CONFIG: "stale" }, emptySettings()).SS_MCP_SECRET_CONFIG,
    undefined,
  );
});

test("mergeSettings preserves the MCP catalog untouched", () => {
  const mcp = {
    servers: [
      { id: "a", scope: "global" as const, enabled: true, transport: "stdio" as const, command: "a" },
    ],
  };
  const base = { ...emptySettings(), mcp };
  const merged = mergeSettings(base, { model: { model: "m" } });
  assert.deepEqual(merged.mcp, mcp);
});
