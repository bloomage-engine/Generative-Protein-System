import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { probeMcpServer } from "../src/mcp/probe.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

test("the stdio probe connects, reports serverInfo and lists tools", async () => {
  const result = await probeMcpServer(
    {
      id: "echo",
      scope: "global",
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
    },
    { timeoutMs: 15_000 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.serverInfo, { name: "echo", version: "1.0.0" });
  assert.equal(result.toolCount, 1);
  assert.deepEqual(result.tools?.map((tool) => tool.name), ["echo"]);
});

test("a probe that cannot start reports a failure instead of throwing", async () => {
  const result = await probeMcpServer(
    {
      id: "missing",
      scope: "global",
      enabled: true,
      transport: "stdio",
      command: "/definitely/not/a/real/mcp-server",
      args: [],
    },
    { timeoutMs: 5_000 },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
