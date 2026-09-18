/**
 * Integration: the DEFAULT subagent-list view respects the `subagents.visibleWindowHours`
 * setting (default 24h when unset), showing a still-running row AND a recent
 * completed row, while an older completed row is hidden behind the History
 * toggle.
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

const H = 3600e3;
// Relative to REAL now so the "recent" row never ages out of the 24h window,
// no matter when the test runs (the panel filters with Date.now()).
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const ROWS = [
  // running, started 10 days ago → always recent via the running branch
  { id: "c1", parentId: "s1", label: "Running long", provider: "spawn", status: "running", startedAt: iso(10 * 24 * H) },
  // completed 2h ago → within the 24h window → visible by default
  { id: "c2", parentId: "s1", label: "Recent task", provider: "fork", status: "completed", stopReason: "completed", startedAt: iso(3 * H), finishedAt: iso(2 * H) },
  // completed 3d ago → outside the window → hidden until the History toggle
  { id: "c3", parentId: "s1", label: "Old task", provider: "spawn", status: "completed", stopReason: "completed", startedAt: iso(3 * 24 * H), finishedAt: iso(3 * 24 * H) },
];

test(
  "the subagent list shows a recent window by default (24h); the toggle opens it",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one (e.g. `npx playwright install chromium`)");
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

      // Pin the subagent-list window to 24h so the assertions are deterministic
      // regardless of what the harness might return.
      await page.route("**/api/settings", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: {}, plugins: {}, agent: {},
            subagents: { visibleWindowHours: 24 },
            runtime: "dsh", settingsPath: "/tmp/s.json",
          }),
        }),
      );
      await page.route("**/api/transport/subagents*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subagents: ROWS }),
        }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      const subagents = page.locator('[data-section="subagents"]');
      await subagents.waitFor({ timeout: 15_000 });

      await subagents.getByRole("button", { name: "Subagents" }).click();
      // The RUNNING row (always recent) + the RECENT COMPLETED row (2h ago) are visible.
      await subagents.getByText("Running long").waitFor({ timeout: 10_000 });
      await subagents.getByText("Recent task").waitFor({ timeout: 10_000 });
      // The OLD completed row (3d ago) is HIDDEN by default (outside the 24h window).
      assert.equal(await subagents.getByText("Old task").count(), 0, "a 3d-ago completed row is hidden by default");

      // Toggling History reveals the older row.
      await subagents.getByLabel("Show past subagent runs").click();
      await subagents.getByText("Old task").waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- web log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
