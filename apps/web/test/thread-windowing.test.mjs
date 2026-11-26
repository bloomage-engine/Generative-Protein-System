/**
 * Thread message windowing: only the last N messages render by default,
 * and a "Load more" button appears when messages are hidden.
 *
 * Prereq: `npm run build -w @gps/transport-client`. Needs a Chromium
 * (SKIPs without one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findChromium,
  freePort,
  killTree,
  newWorkbenchPage,
  mockRecordSurface,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const VIEW = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  subagents: {},
  thread: { visibleMessageCount: 3 },
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

const MANY_MESSAGES =
  'data: {"type":"update-state","path":[],"operations":[' +
  '{"type":"set","path":["status"],"value":"idle"},' +
  '{"type":"set","path":["messages","u1"],"value":{"id":"u1","role":"user","parts":[{"type":"text","text":"msg-1"}]}},' +
  '{"type":"set","path":["messages","a1"],"value":{"id":"a1","role":"assistant","parts":[{"type":"text","text":"reply-1"}]}},' +
  '{"type":"set","path":["messages","u2"],"value":{"id":"u2","role":"user","parts":[{"type":"text","text":"msg-2"}]}},' +
  '{"type":"set","path":["messages","a2"],"value":{"id":"a2","role":"assistant","parts":[{"type":"text","text":"reply-2"}]}},' +
  '{"type":"set","path":["messages","u3"],"value":{"id":"u3","role":"user","parts":[{"type":"text","text":"msg-3"}]}},' +
  '{"type":"set","path":["messages","a3"],"value":{"id":"a3","role":"assistant","parts":[{"type":"text","text":"reply-3"}]}},' +
  '{"type":"set","path":["messages","u4"],"value":{"id":"u4","role":"user","parts":[{"type":"text","text":"msg-4"}]}},' +
  '{"type":"set","path":["messages","a4"],"value":{"id":"a4","role":"assistant","parts":[{"type":"text","text":"reply-4"}]}},' +
  '{"type":"set","path":["messages","u5"],"value":{"id":"u5","role":"user","parts":[{"type":"text","text":"msg-5"}]}}' +
  "]}\n\n" +
  "data: [DONE]\n\n";

/**
 * Set up all mocked surfaces for a windowing test — transport POST returns
 * MANY_MESSAGES (5 messages), watch is silent, workspace exists.
 */
async function mockWindowingSurfaces(page) {
  // Transport POST: return 5 messages instead of the default 2
  await page.route("**/api/transport*", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: MANY_MESSAGES,
    });
  });
  // Watch stub (silent, never-ending)
  await page.route("**/api/transport/watch*", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  // Commands stub
  await page.route("**/api/transport/commands*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"commands":[]}',
    }),
  );
  // Workspace stubs
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
  await page.route("**/api/settings", (route) =>
    route.fulfill({ json: VIEW }),
  );
}

test(
  "thread renders only the last N messages when windowed",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWindowingSurfaces(page);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      // Wait for the thread to render messages
      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // 9 messages total (u1,a1,u2,a2,u3,a3,u4,a4,u5), visibleMessageCount=3
      // → only last 3 rendered: u4 (msg-4), a4 (reply-4), u5 (msg-5)
      await page.getByText("msg-4").waitFor({ timeout: 5_000 });
      const msg1Visible = await page.getByText("msg-1").isVisible().catch(() => false);
      const msg2Visible = await page.getByText("msg-2").isVisible().catch(() => false);
      const msg3Visible = await page.getByText("msg-3").isVisible().catch(() => false);
      assert.equal(msg1Visible, false, "msg-1 should be hidden when windowed to 3");
      assert.equal(msg2Visible, false, "msg-2 should be hidden when windowed to 3");
      assert.equal(msg3Visible, false, "msg-3 should be hidden when windowed to 3");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "thread shows Load more button when messages are hidden",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWindowingSurfaces(page);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // Load more button should appear when some messages are hidden
      const loadMore = page.getByRole("button", { name: /load more/i });
      await loadMore.waitFor({ timeout: 5_000 });
      const loadMoreVisible = await loadMore.isVisible();
      assert.equal(loadMoreVisible, true, "Load more button should be visible when messages are hidden");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "clicking Load more reveals hidden messages",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWindowingSurfaces(page);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // Click Load more
      await page.getByRole("button", { name: /load more/i }).click();

      // After clicking, all messages should be visible
      await page.getByText("msg-1").waitFor({ timeout: 5_000 });
      await page.getByText("msg-2").waitFor({ timeout: 5_000 });
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
