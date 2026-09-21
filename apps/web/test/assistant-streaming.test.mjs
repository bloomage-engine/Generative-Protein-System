/**
 * Regression: assistant text must REVEAL smoothly even when the runtime
 * delivers tokens in a burst.
 *
 * The service forwards live tokens as it receives them, so a whole cluster can
 * land in one socket read; the model then pauses and the next cluster lands
 * later. `@science-studio/transport-client`'s `MarkdownText` turns that into a
 * typewriter reveal with `useSmooth`. Without a per-frame cap the animator
 * drains the whole backlog inside its window (`maxCharsPerFrame` defaults to
 * Infinity), so a burst paints as one visible gulp — the user's "text jumps in
 * chunks". This test drives a REAL burst through a stub transport and asserts
 * the rendered text never grows by more than a few characters in a frame.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
 * (SKIPs without one). The transport is deliberately NOT mocked in the browser:
 * a real socket stub lets one `write` deliver the whole burst as a single read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import {
  closeWithDeadline,
  findChromium,
  freePort,
  killTree,
  mockRecordSurface,
  newWorkbenchPage,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const NL = "\n";
/**
 * Big enough that the uncapped drain (the old behaviour: `drainMs / backlog`
 * per frame) would reveal ~85 chars in one frame, while the 4-char cap plus
 * commit throttling stays in the low tens.
 */
const BURST_CHARS = 1600;
const MAX_JUMP = 20;

const frame = (operations) =>
  `data: ${JSON.stringify({ type: "update-state", path: [], operations })}${NL}${NL}`;

const answerText = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);

/**
 * A real-socket stub of `/api/transport`: a real user send (an
 * `add-message` command) answers with the message create, the whole token
 * burst in a SINGLE `write`, then a hold (so the part stays `running` while
 * the reveal runs) and the settle + `[DONE]`. The mount probe POSTs EMPTY
 * commands (like the real service's first-use probe it answers a quiet settle
 * — no burst, no transcript). The old stub bursted BOTH on the same message id,
 * and that artificial interleave (two 1600-char streams + their settle/part
 * flips colliding mid-reveal) is what occasionally produced one legitimate
 * full repaint that the per-frame cap cannot tell apart from a regression.
 */
async function startBurstStub() {
  const target = answerText.slice(0, BURST_CHARS);
  const path = ["messages", "a1", "parts", "0", "text"];
  const count = 60;
  const size = Math.ceil(target.length / count);
  const burst = [];
  for (let i = 0; i < count; i++) {
    const value = target.slice(i * size, (i + 1) * size);
    if (value) burst.push({ type: "append-text", path, value });
  }

  const server = createHttpServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/api/transport") && !req.url.includes("/watch")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (!body.includes("add-message")) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          res.write(frame([{ type: "set", path: ["status"], value: "idle" }]));
          res.write(`data: [DONE]${NL}${NL}`);
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(
          frame([
            { type: "set", path: ["status"], value: "running" },
            {
              type: "set",
              path: ["messages", "a1"],
              value: { id: "a1", role: "assistant", parts: [{ type: "text", text: "start " }] },
            },
          ]),
        );
        // The whole burst in one write — the browser reads it as one chunk.
        res.write(frame(burst));
        setTimeout(() => {
          res.write(frame([{ type: "set", path: ["status"], value: "idle" }]));
          res.write(`data: [DONE]${NL}${NL}`);
          res.end();
        }, 1800);
      });
      return;
    }
    if (req.url.startsWith("/api/transport/commands")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"commands":[]}');
      return;
    }
    // The standing watch is irrelevant here (and must not be a 200 that ends).
    if (req.url.startsWith("/api/transport/watch")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function mockSurfaces(page) {
  await page.route("**/api/workspace/entries*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "",
        entries: [{ path: "notes.txt", name: "notes.txt", kind: "file", size: 3 }],
      }),
    }),
  );
  await page.route("**/api/workspace/file*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/plain" }, body: "hi" }),
  );
  await mockRecordSurface(page);
}

test(
  "a token burst is revealed frame by frame, never in one gulp",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const stub = await startBurstStub();
    const port = await freePort();
    const server = startWebServer(port, { TRANSPORT_SERVICE_URL: stub.url });
    const base = `http://localhost:${port}`;
    let browser;
    try {
      await waitForServer(base, 120_000);
      await warmWorkbench(base, { transport: true });

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);
      await mockSurfaces(page);

      await page.goto(`${base}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      const input = page.locator("textarea.aui-composer-input").first();
      await input.waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500); // let the mount probe settle

      await page.evaluate(() => {
        window.__samples = [];
        window.__stop = false;
        const len = () => {
          const nodes = document.querySelectorAll(
            '[data-slot="aui_assistant-message-content"]',
          );
          return nodes.length ? nodes[nodes.length - 1].innerText.length : 0;
        };
        const tick = () => {
          window.__samples.push({ t: performance.now(), len: len() });
          if (!window.__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      await input.click();
      await input.fill("go");
      await input.press("Enter");

      let last = -1;
      let stableSince = Date.now();
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(500);
        const len = await page.evaluate(() => {
          const nodes = document.querySelectorAll(
            '[data-slot="aui_assistant-message-content"]',
          );
          return nodes.length ? nodes[nodes.length - 1].innerText.length : 0;
        });
        if (len !== last) {
          last = len;
          stableSince = Date.now();
        } else if (len > 100 && Date.now() - stableSince > 2000) break;
      }

      const samples = await page.evaluate(() => {
        window.__stop = true;
        return window.__samples;
      });

      const growth = samples.filter(
        (s, i) => i === 0 || s.len !== samples[i - 1].len,
      );
      const jumps = [];
      for (let i = 1; i < growth.length; i++) {
        jumps.push(growth[i].len - growth[i - 1].len);
      }
      const maxJump = Math.max(...jumps.filter((j) => j > 0), 0);
      const rendered = samples.at(-1)?.len ?? 0;

      assert.ok(
        rendered > BURST_CHARS,
        `the burst must fully render (rendered ${rendered}, expected > ${BURST_CHARS})`,
      );
      assert.ok(
        maxJump <= MAX_JUMP,
        `one frame revealed ${maxJump} chars (cap ${MAX_JUMP}) — a burst painted as one gulp; jumps: ${JSON.stringify(jumps)}`,
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      if (browser) await closeWithDeadline(browser.close(), 10_000);
      killTree(server.child, port);
      await closeWithDeadline(stub.close(), 5_000);
    }
  },
);
