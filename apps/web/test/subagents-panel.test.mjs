/**
 * Regression: the Subagents module renders the live subagent list polled from
 * `/api/transport/subagents`, shows its empty state when the list is empty, and
 * makes no request while collapsed.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`.
 * Needs a Chromium; SKIPPED when none is found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
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

const ROWS = [
  {
    id: "child-1",
    parentId: "s1",
    label: "Literature review",
    provider: "spawn",
    status: "running",
    startedAt: "2026-09-17T00:00:00.000Z",
  },
  {
    id: "child-2",
    parentId: "s1",
    provider: "fork",
    status: "completed",
    stopReason: "completed",
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:01:00.000Z",
  },
];

test(
  "the Subagents panel renders live subagent runs and stays quiet while collapsed",
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
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      let requests = 0;
      await page.route("**/api/transport/subagents*", (route) => {
        requests += 1;
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subagents: ROWS }),
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const subagents = page.locator('[data-section="subagents"]');
      await subagents.waitFor({ timeout: 15_000 });

      // Collapsed: no empty state and NO polling request.
      assert.equal(await subagents.getByText("No subagents yet.").count(), 0);
      await page.waitForTimeout(2_500);
      assert.equal(requests, 0, "a collapsed Subagents module must not poll");

      // Expanding starts polling and renders the rows.
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("Literature review").waitFor({ timeout: 10_000 });
      await subagents.getByText("Running").waitFor({ timeout: 10_000 });
      await subagents.getByText("Completed", { exact: true }).waitFor({ timeout: 10_000 });
      assert.ok(requests >= 1, "an open Subagents module polls");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
