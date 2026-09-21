/**
 * Thread windowing integration: verifies that the settings Thread tab,
 * the studio store, and the Thread component work together end-to-end.
 *
 * Covers:
 *   - Settings visibleMessageCount flows into the Thread windowing
 *   - Session switch resets visibleMessageCount to default
 *   - Load-more + session switch interaction
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
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
  mockWorkbenchSurfaces,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const VIEW_20 = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  subagents: {},
  thread: { visibleMessageCount: 20 },
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

const VIEW_2 = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  subagents: {},
  thread: { visibleMessageCount: 2 },
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

/**
 * 5 user+assistant message pairs → 9 messages total.
 */
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
 * Mock surfaces with a configurable settings view and transport returning MANY_MESSAGES.
 *
 * The settings endpoint is STATEFUL like the service: a save `PUT`s a patch and
 * the view is then read back on the next boot. A static mock would hand back
 * the original view after every save, so "persists across reload" could never
 * be exercised — the Thread count a test saves is the one the app next reads.
 */
async function mockIntegrationSurfaces(page, view) {
  await page.route("**/api/transport*", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: MANY_MESSAGES,
    });
  });
  await page.route("**/api/transport/watch*", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.route("**/api/transport/commands*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"commands":[]}',
    }),
  );
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
  const state = structuredClone(view);
  await page.route("**/api/settings", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const patch = request.postDataJSON() ?? {};
      if (patch.thread !== undefined) {
        state.thread = { ...(state.thread ?? {}) };
        if (patch.thread.visibleMessageCount === null) {
          delete state.thread.visibleMessageCount;
        } else {
          state.thread.visibleMessageCount = patch.thread.visibleMessageCount;
        }
      }
    }
    return route.fulfill({ json: state });
  });
}

test(
  "settings thread.visibleMessageCount is reflected in the Thread windowing",
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

      // Set visibleMessageCount=2 in settings
      await mockIntegrationSurfaces(page, VIEW_2);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      // Wait for messages to load (9 messages: u1,a1,u2,a2,u3,a3,u4,a4,u5)
      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // With visibleMessageCount=2, only last 2 messages rendered: a4 (reply-4), u5 (msg-5)
      await page.getByText("reply-4").waitFor({ timeout: 5_000 });
      const msg1Visible = await page.getByText("msg-1").isVisible().catch(() => false);
      const msg3Visible = await page.getByText("msg-3").isVisible().catch(() => false);
      const msg4Visible = await page.getByText("msg-4").isVisible().catch(() => false);
      assert.equal(msg1Visible, false, "msg-1 hidden with visibleMessageCount=2");
      assert.equal(msg3Visible, false, "msg-3 hidden with visibleMessageCount=2");
      assert.equal(msg4Visible, false, "msg-4 hidden with visibleMessageCount=2");

      // Load more button shows hidden count (7 messages hidden)
      const loadMore = page.getByRole("button", { name: /load more/i });
      await loadMore.waitFor({ timeout: 5_000 });
      const label = await loadMore.textContent();
      assert.match(label, /7/, "load more shows 7 hidden messages");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "clicking Load more reveals additional messages",
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

      await mockIntegrationSurfaces(page, VIEW_2);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // 9 messages, 7 hidden behind the count=2 window, so Load more is on.
      const loadMore = page.getByRole("button", { name: /load more/i });
      await loadMore.waitFor({ timeout: 5_000 });

      // One Load more loads a DEFAULT-SIZE window (the store's pinned step is
      // count + 20, not "double the window"), which covers all 9: the hidden
      // messages are revealed in full and the button retires — there is nothing
      // left to load.
      await loadMore.click();
      await page.getByText("reply-1").waitFor({ timeout: 5_000 });
      await page.getByText("msg-1").waitFor({ timeout: 5_000 });
      const loadMoreGone = await page
        .getByRole("button", { name: /load more/i })
        .isVisible()
        .catch(() => false);
      assert.equal(loadMoreGone, false, "all messages revealed: Load more retires");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "settings change in the Thread tab persists and affects windowing",
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

      await mockIntegrationSurfaces(page, VIEW_20);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      // Wait for messages to load
      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // With visibleMessageCount=20 and 9 messages, all should be visible
      const msg1Visible = await page.getByText("msg-1").isVisible();
      assert.equal(msg1Visible, true, "msg-1 visible when visibleMessageCount=20 > 9 messages");

      // No load more button when all messages are visible
      const loadMoreGone = await page.getByRole("button", { name: /load more/i }).isVisible().catch(() => false);
      assert.equal(loadMoreGone, false, "no Load more when all messages visible");

      // Open settings, change Thread visibleMessageCount to 2
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Thread" }).click();

      const input = page.getByLabel(/visible messages/i);
      await input.waitFor({ timeout: 5_000 });
      await input.fill("2");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText("Saved.").waitFor({ timeout: 10_000 });

      // Close settings dialog
      await page.getByRole("button", { name: "Close" }).click();

      // Reload the page to pick up the new settings
      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // Now visibleMessageCount=2, only last 2 messages should render
      const loadMoreNow = await page.getByRole("button", { name: /load more/i }).isVisible().catch(() => false);
      assert.equal(loadMoreNow, true, "Load more appears after settings change to smaller window");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "session switch resets the visible message count to default",
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

      await mockIntegrationSurfaces(page, VIEW_2);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });

      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      // Premise: the persisted count=2 window is in force (7 of 9 hidden).
      const loadMore = page.getByRole("button", { name: /load more/i });
      await loadMore.waitFor({ timeout: 5_000 });

      // A Session switch is an in-page scope COMMIT (the workbench never
      // navigates away to switch), not a page boot — so the app's state
      // survives and the commit itself is what must reset the window. Commit
      // it the way a reader would: open the Projects pane and double-click
      // p2's Session.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await page.getByRole("button", { name: "Beta", exact: true }).click();
      await page
        .getByRole("button", { name: "Beta session", exact: true })
        .dblclick();

      // The new Session's history (the same 9 mocked messages) must open with
      // the DEFAULT window (20): all visible, nothing left to load. If the
      // switch kept the 2-window, msg-1 would stay hidden.
      await page.getByText("msg-1").waitFor({ timeout: 30_000 });
      const loadMoreAfterSwitch = await page
        .getByRole("button", { name: /load more/i })
        .isVisible()
        .catch(() => false);
      assert.equal(loadMoreAfterSwitch, false, "no Load more after a Session switch (count reset to default)");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
