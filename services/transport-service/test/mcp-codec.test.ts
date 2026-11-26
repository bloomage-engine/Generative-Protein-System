import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServerSettings } from "@gps/transport";
import {
  normalizeServer,
  parseMcpSettings,
  serversForProject,
  viewMcpServer,
} from "../src/mcp/codec.js";

const stdio = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "github",
  scope: "global",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  env: { GITHUB_TOKEN: "secret" },
  ...overrides,
});

test("a stored row is normalized and its credentials are projected to key names", () => {
  const parsed = parseMcpSettings({
    servers: [stdio(), { ...stdio({ id: "web" }), transport: "streamable-http", url: "http://localhost/mcp", headers: { Authorization: "Bearer x" } }],
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.settings.servers.length, 2);
  const view = viewMcpServer(parsed.settings.servers[0]!);
  assert.deepEqual(view.envKeys, ["GITHUB_TOKEN"]);
  assert.equal("env" in view, false);
  assert.deepEqual(view.headerKeys, []);
});

test("project scope requires a safe projectId; global scope rejects one", () => {
  const project = normalizeServer(
    { ...stdio(), scope: "project", projectId: "proj-a" },
    undefined,
  );
  assert.ok("value" in project);
  assert.equal(project.value.projectId, "proj-a");

  const missing = normalizeServer({ ...stdio(), scope: "project" }, undefined);
  assert.ok("error" in missing);
  assert.match(missing.error, /projectId/);

  const unsafe = normalizeServer(
    { ...stdio(), scope: "project", projectId: "../../etc" },
    undefined,
  );
  assert.ok("error" in unsafe);

  const global = normalizeServer(
    { ...stdio(), scope: "global", projectId: "proj-a" },
    undefined,
  );
  assert.ok("error" in global);
});

test("updating a project row can move it to global without keeping projectId", () => {
  const existing = normalizeServer(
    { ...stdio(), scope: "project", projectId: "proj-a" },
    undefined,
  );
  assert.ok("value" in existing);
  const updated = normalizeServer({ scope: "global", transport: "stdio", command: "npx" }, existing.value);
  assert.ok("value" in updated);
  assert.equal(updated.value.scope, "global");
  assert.equal(updated.value.projectId, undefined);
  assert.deepEqual(updated.value.env, { GITHUB_TOKEN: "secret" });
});

test("secret patches replace one key, remove one, and preserve the rest", () => {
  const existing = normalizeServer(stdio(), undefined);
  assert.ok("value" in existing);
  const updated = normalizeServer(
    {
      env: { GITHUB_TOKEN: null, NEW_TOKEN: "new" },
      transport: "stdio",
      command: "npx",
    },
    existing.value,
  );
  assert.ok("value" in updated);
  assert.deepEqual(updated.value.env, { NEW_TOKEN: "new" });
});

test("transport-specific fields are validated", () => {
  const stdioNoCommand = normalizeServer({ ...stdio(), command: "" }, undefined);
  assert.ok("error" in stdioNoCommand);

  const http = normalizeServer(
    { id: "web", scope: "global", transport: "streamable-http", url: "https://example.com/mcp" },
    undefined,
  );
  assert.ok("value" in http);
  assert.equal(http.value.url, "https://example.com/mcp");

  const httpBad = normalizeServer(
    { id: "web", scope: "global", transport: "streamable-http", url: "file:///etc/passwd" },
    undefined,
  );
  assert.ok("error" in httpBad);
});

test("a project child sees global rows plus its own, never another project's", () => {
  const servers: McpServerSettings[] = [
    { id: "global", scope: "global", enabled: true, transport: "stdio", command: "a" },
    { id: "a", scope: "project", projectId: "proj-a", enabled: true, transport: "stdio", command: "a" },
    { id: "b", scope: "project", projectId: "proj-b", enabled: true, transport: "stdio", command: "b" },
  ];
  assert.deepEqual(
    serversForProject(servers, "proj-a").map((server) => server.id),
    ["global", "a"],
  );
  assert.deepEqual(
    serversForProject(servers, undefined).map((server) => server.id),
    ["global"],
  );
});

test("the file loader drops duplicate and malformed rows instead of failing", () => {
  const parsed = parseMcpSettings({
    servers: [
      stdio(),
      stdio(),
      { id: "broken", scope: "global", transport: "stdio" },
      { id: "bad id", scope: "global", transport: "stdio", command: "x" },
    ],
  });
  assert.deepEqual(parsed.settings.servers.map((server) => server.id), ["github"]);
  assert.equal(parsed.errors.length, 3);
});
