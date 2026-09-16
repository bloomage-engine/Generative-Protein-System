import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { getFreePort } from "../src/shared/net.js";

test("getFreePort returns a port that can be bound", async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port) && port > 0);
  await new Promise<void>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
  });
});
