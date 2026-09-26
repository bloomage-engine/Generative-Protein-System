import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSettings, McpSettingsPatch } from "@science-studio/transport";
import { emptySettings, loadSettings, mergeSettings, parseSettingsPatch, saveSettings, viewOf } from "../src/settings.js";

const GITHUB: McpServerSettings = {
  serverName: "github",
  transport: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "secret-1" },
};

const WEB: McpServerSettings = {
  serverName: "web",
  transport: "streamable-http",
  enabled: true,
  url: "http://localhost:3000/mcp",
  headers: { Authorization: "Bearer t0ken" },
};

const base = () => ({ ...emptySettings(), mcp: { servers: [GITHUB, WEB] as McpServerSettings[] } });

test("parseSettingsPatch accepts a valid mcp list and normalizes it", () => {
  const parsed = parseSettingsPatch({ mcp: { servers: [GITHUB, { serverName: "web", transport: "streamable-http", url: "http://h:1/mcp" }] } });
  assert.ok("patch" in parsed);
  assert.deepEqual(parsed.patch.mcp?.servers?.[0], GITHUB);
});

test("parseSettingsPatch rejects every malformed shape", () => {
  const bad = (body: unknown): string => {
    const parsed = parseSettingsPatch(body);
    assert.ok("error" in parsed);
    return (parsed as { error: string }).error;
  };
  assert.match(bad({ mcp: { servers: "no" } }), /array/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, serverName: "bad name" }] } }), /serverName/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, serverName: "x".repeat(33) }] } }), /serverName/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB }, { ...WEB, serverName: "github" }] } }), /duplicate/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, transport: "sse" }] } }), /transport/);
  assert.match(bad({ mcp: { servers: [{ serverName: "g", transport: "stdio" }] } }), /command is required/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, args: [1, 2] }] } }), /args/);
  assert.match(bad({ mcp: { servers: [{ ...WEB, url: "ftp://h/mcp" }] } }), /http\(s\) URL/);
  assert.match(bad({ mcp: { servers: [{ ...WEB, enabled: "yes" }] } }), /enabled/);
  // A stdio field on an http row (and vice versa) is unknown — a typo must not
  // silently mount a broken server.
  assert.match(bad({ mcp: { servers: [{ ...WEB, command: "npx" }] } }), /not a streamable-http server field/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, url: "http://h/mcp" }] } }), /not a stdio server field/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, reconnect: { enabled: false } }] } }), /not a stdio server field/);
  assert.match(bad({ mcp: { servers: [{ ...GITHUB, env: { A: 1 } }] } }), /values must be strings/);
});

test("null clears every server; absent keeps the list", () => {
  const cleared = mergeSettings(base(), { mcp: { servers: null } });
  assert.deepEqual(cleared.mcp?.servers, []);
  const kept = mergeSettings(base(), {});
  assert.deepEqual(kept.mcp?.servers, base().mcp?.servers);
});

test("a row's absent secret keys KEEP their stored values; null deletes; a string replaces", () => {
  const patched: McpSettingsPatch = {
    servers: [
      // github keeps GITHUB_TOKEN (absent), deletes nothing, adds a new var.
      { serverName: "github", transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { NEW_VAR: "v" } },
      // web clears its Authorization.
      { serverName: "web", transport: "streamable-http", url: "http://localhost:3000/mcp", headers: { Authorization: null } },
    ],
  };
  const merged = mergeSettings(base(), { mcp: patched });
  const github = merged.mcp?.servers.find((s) => s.serverName === "github");
  const web = merged.mcp?.servers.find((s) => s.serverName === "web");
  assert.ok(github?.transport === "stdio" && web?.transport === "streamable-http");
  assert.deepEqual(github.env, { GITHUB_TOKEN: "secret-1", NEW_VAR: "v" }, "absent key = keep");
  assert.deepEqual(web.headers, undefined, "cleared map is omitted entirely");
  assert.equal(github.command, "npx");
  assert.deepEqual(github.args, ["-y", "pkg"], "non-secret fields are a row replace");
});

test("a renamed or transport-switched row drops the old secrets; a removed row takes them with it", () => {
  const renamed = mergeSettings(base(), {
    mcp: { servers: [{ serverName: "gh2", transport: "stdio", command: "npx" }] },
  });
  assert.equal(renamed.mcp?.servers.length, 1);
  assert.equal(renamed.mcp?.servers[0]?.serverName, "gh2");
  assert.ok(renamed.mcp?.servers[0]?.transport === "stdio" && renamed.mcp?.servers[0].env === undefined);

  const switched = mergeSettings(base(), {
    mcp: { servers: [{ serverName: "github", transport: "streamable-http", url: "http://h/mcp" }] },
  });
  const row = switched.mcp?.servers[0];
  assert.ok(row?.transport === "streamable-http");
  assert.deepEqual(row.headers, undefined, "a transport switch does not inherit the env secrets");
});

test("the view masks secret VALUES and shows the configured KEY names", () => {
  const view = viewOf(base(), "/tmp/settings.json", {});
  assert.deepEqual(view.mcp.servers[0], {
    serverName: "github",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envConfigured: ["GITHUB_TOKEN"],
  });
  assert.deepEqual(view.mcp.servers[1], {
    serverName: "web",
    transport: "streamable-http",
    enabled: true,
    url: "http://localhost:3000/mcp",
    headersConfigured: ["Authorization"],
  });
  assert.ok(!JSON.stringify(view).includes("secret-1"), "no secret value may reach the response");
  assert.ok(!JSON.stringify(view).includes("t0ken"));
});

test("a hand-edited settings file with a bad server loses the section, not the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-mcp-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        model: { provider: "ollama-local" },
        plugins: {},
        agent: {},
        mcp: { servers: [{ serverName: "ok", transport: "stdio", command: "x" }, { serverName: "BAD NAME", transport: "stdio", command: "y" }] },
      }),
      "utf8",
    );
    const settings = await loadSettings(path);
    assert.equal(settings.model.provider, "ollama-local");
    assert.deepEqual(settings.mcp?.servers, [], "the whole invalid section is dropped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stored row's null secret values are dropped on load (delete markers are a PUT-only word)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-mcp-nulls-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({ mcp: { servers: [{ serverName: "ok", transport: "stdio", command: "x", env: { A: "a", B: null } }] } }),
      "utf8",
    );
    const settings = await loadSettings(path);
    const row = settings.mcp?.servers[0];
    assert.ok(row?.transport === "stdio");
    assert.deepEqual(row.env, { A: "a" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the settings file persists plaintext secrets at mode 0600 (the write-only rule is over HTTP)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-mcp-save-"));
  try {
    const path = join(dir, "settings.json");
    await saveSettings(path, base());
    assert.equal(((await stat(path)).mode & 0o777).toString(8), "600");
    const reloaded = await loadSettings(path);
    assert.deepEqual(reloaded.mcp?.servers, base().mcp?.servers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
