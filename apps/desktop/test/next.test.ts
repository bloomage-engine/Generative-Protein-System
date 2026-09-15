import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForHttp } from "../src/server/next.js";

test("waitForHttp resolves once the server answers", async () => {
  const srv = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const address = srv.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, { exitCode: null });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("waitForHttp rejects when the process exits", async () => {
  await assert.rejects(() => waitForHttp("http://127.0.0.1:1/", { exitCode: 1 }), /next server exited/);
});
