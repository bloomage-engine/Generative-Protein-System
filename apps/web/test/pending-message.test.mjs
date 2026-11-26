/**
 * Regression: a just-sent user message must render IMMEDIATELY, before the
 * server echoes it back.
 *
 * The transport runtime holds a send in transit until the server's first
 * state-changing frame, and the converter is the only place that can render it
 * optimistically (assistant-ui's `connectionMetadata.pendingCommands`). When the
 * converter ignored that metadata, the user's own message appeared only after
 * the round trip — on the dsh runtime the round trip also covers the adapter's
 * cold mirror read, so the composer looked like it swallowed the message for a
 * beat. This test holds the send's response open (the server never
 * acknowledges), so the only way the text can appear is the optimistic path.
 * If the converter regresses to ignoring `pendingCommands`, this goes red.
 *
 * Prereq: `npm run build -w @gps/transport-client` (the web app
 * imports the client package from its dist build).
 *
 * Needs a Chromium. Resolution order: $PLAYWRIGHT_CHROMIUM_EXECUTABLE, a
 * Playwright browser cache, then the system Chrome. When none is found the test
 * is SKIPPED, not failed, so it does not break a browser-less `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  SNAPSHOT_FRAMES,
  findChromium,
  freePort,
  killTree,
  mockRecordSurface,
  newWorkbenchPage,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const USER_TEXT = "optimistic-echo-marker";

test(
  "the user's message renders before the server acknowledges it",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip(
        "no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one (e.g. `npx playwright install chromium`)",
      );
      return;
    }

    const port = await freePort();
    const server = startWebServer(port);
    let browser;
    let releaseSend;
    const sendRelease = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let onSend;
    const sendSeen = new Promise((resolve) => {
      onSend = resolve;
    });

    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockRecordSurface(page);
      // The watch/commands/workspace surfaces stay finite; the transport POST is
      // the one under test and is handled below.
      await page.route("**/api/transport/watch*", (route) => route.fulfill({ status: 404, body: "" }));
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
          body: JSON.stringify({ path: "", entries: [] }),
        }),
      );

      // Regex so the query-carrying send/probe match but `/transport/watch` does not.
      await page.route(/\/api\/transport(\?|$)/, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON();
        if (!Array.isArray(body.commands) || body.commands.length === 0) {
          // The mount probe.
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: SNAPSHOT_FRAMES,
          });
        }
        // A send: hold the response open — the server must not be able to echo.
        onSend();
        await sendRelease;
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: "data: [DONE]\n\n",
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByLabel("Message input").fill(USER_TEXT);
      await page.getByLabel("Send message").click();
      await sendSeen;

      // Nothing can arrive from the held server; only the optimistic command can
      // put this text on screen.
      await page.getByText(USER_TEXT).waitFor({ timeout: 5_000 });
      assert.equal(
        await page.getByText(USER_TEXT).count(),
        1,
        "the sent message must render immediately, not wait for the server echo",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      releaseSend?.();
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
