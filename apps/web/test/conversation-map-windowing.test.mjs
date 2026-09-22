/**
 * The conversation map (the turn rail in the thread's gutter) binds to the SAME
 * window the Thread renders. `ThreadMessageWindow` shows only the last
 * `visibleMessageCount` messages and hides the rest behind "Load more"; the map
 * must agree — a tick for a hidden turn is a dead control (clicking it scrolls
 * to a `[data-message-id]` element that was never mounted), and it would
 * advertise turns the reader cannot actually see.
 *
 * This loads a thread longer than the window and asserts the rail lists exactly
 * the visible turns and none of the hidden ones.
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

// 9 messages: u1,a1,u2,a2,u3,a3,u4,a4,u5. With visibleMessageCount=3 the Thread
// renders the last three — u4, a4, u5 — so the map should show 2 turns (u4 and
// u5), not the 5 turns a full-listing would.
const NINE_MESSAGES =
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

async function mockWindowingSurfaces(page) {
  // Transport POST: reconcile to the 9-message transcript.
  await page.route("**/api/transport*", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: NINE_MESSAGES,
    });
  });
  // Watch stub (silent, never-ending) + commands stub.
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
  // Workspace stubs (so the shell is a fully-loaded workbench).
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
  await page.route("**/api/settings", (route) => route.fulfill({ json: VIEW }));
}

test(
  "the conversation map binds only the rendered window's turns",
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

      // Wait for the latest (visible) message to render, so the rail is populated.
      await page.getByText("msg-5").waitFor({ timeout: 30_000 });

      const ticks = page.locator('[data-slot="conversation-map-tick"]');
      await ticks.first().waitFor({ timeout: 5_000 });

      // The window is the last 3 messages (u4, a4, u5) → 2 turns: u4 (with its
      // reply) and u5. A full-listing would be 5 turns — that is the bug.
      assert.equal(
        await ticks.count(),
        2,
        "the map should bind the 2 visible turns (u4, u5), not all 5 messages' turns",
      );

      // The visible turns are present and anchored to rendered messages.
      assert.equal(
        await page
          .locator('[data-slot="conversation-map-tick"][aria-label="msg-4"]')
          .count(),
        1,
        "visible turn u4 should be listed",
      );
      assert.equal(
        await page
          .locator('[data-slot="conversation-map-tick"][aria-label="msg-5"]')
          .count(),
        1,
        "visible turn u5 should be listed",
      );

      // The hidden turns are not bound at all — no tick, no dead scroll target.
      for (const hidden of ["msg-1", "msg-2", "msg-3"]) {
        assert.equal(
          await page
            .locator(`[data-slot="conversation-map-tick"][aria-label="${hidden}"]`)
            .count(),
          0,
          `hidden turn "${hidden}" must not be bound to the conversation map`,
        );
      }
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
