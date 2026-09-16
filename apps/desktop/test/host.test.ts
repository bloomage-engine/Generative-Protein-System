import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startHost } from "../src/server/host.js";
import { readyMessage } from "../src/server/report.js";

test("startHost wires the web server to the api port and closes both", async () => {
  let seenApiBaseUrl = "";
  let apiClosed = false;
  let webClosed = false;
  const host = await startHost({
    nextDir: "/unused",
    env: {},
    startApi: async () => {
      const srv = createServer((_req, res) => res.end("api"));
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return {
        port,
        close: async () => {
          apiClosed = true;
          await new Promise<void>((resolve) => srv.close(() => resolve()));
        },
      };
    },
    startWeb: async ({ apiBaseUrl }) => {
      seenApiBaseUrl = apiBaseUrl;
      return {
        port: 45678,
        close: async () => {
          webClosed = true;
        },
      };
    },
  });
  assert.match(seenApiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(host.webPort, 45678);
  assert.ok(host.apiPort > 0);
  await host.close();
  assert.equal(apiClosed, true);
  assert.equal(webClosed, true);
});

test("readyMessage has the shape the fork parent listens for", () => {
  assert.deepEqual(readyMessage({ webPort: 1, apiPort: 2 }), { type: "ready", webPort: 1, apiPort: 2 });
});

test("close still closes the api when the web close rejects, preserving the first error", async () => {
  let apiClosed = false;
  const host = await startHost({
    nextDir: "/unused",
    env: {},
    startApi: async () => ({
      port: 1234,
      close: async () => {
        apiClosed = true;
      },
    }),
    startWeb: async () => ({
      port: 45678,
      close: async () => {
        throw new Error("web boom");
      },
    }),
  });
  await assert.rejects(() => host.close(), /web boom/);
  assert.equal(apiClosed, true);
});
