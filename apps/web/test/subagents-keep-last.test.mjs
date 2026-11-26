/**
 * A failed Subagents poll must NOT clear the panel (docs/adr/0021): the proxy
 * relays the failure and `useSubagents` keeps its last good list. The route is
 * mocked to answer one running row, then 500 — after a second poll the row is
 * still shown.
 *
 * Prereq: `npm run build -w @gps/transport-client`. Needs a Chromium
 * (SKIPs without one).
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

async function waitFor(predicate, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the condition");
}

const ROW = {
  id: "c1",
  parentId: "s1",
  label: "Keep me",
  provider: "spawn",
  status: "running",
  startedAt: new Date().toISOString(),
};

test(
  "a failed Subagents poll keeps the last good list",
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

      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);
      await page.route("**/api/settings", (route) =>
        route.fulfill({
          json: {
            model: {},
            plugins: {},
            agent: {},
            subagents: { visibleWindowHours: 24 },
            runtime: "dsh",
            settingsPath: "/tmp/s.json",
          },
        }),
      );

      let calls = 0;
      await page.route("**/api/transport/subagents*", (route) => {
        calls += 1;
        if (calls === 1) return route.fulfill({ json: { subagents: [ROW] } });
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "boom" }),
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      const panel = page.locator('[data-section="subagents"]');
      await panel.waitFor({ timeout: 15_000 });
      await panel.getByRole("button", { name: "Subagents" }).click();
      await panel.getByText("Keep me").waitFor({ timeout: 10_000 });

      // Wait until the first success plus at least two failing polls have
      // landed, then let the render settle: if keep-last were broken the list
      // would already be blank.
      await waitFor(() => calls >= 3);
      await page.waitForTimeout(500);
      assert.equal(
        await panel.getByText("Keep me").count(),
        1,
        "the last good list survived the failed polls",
      );
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);