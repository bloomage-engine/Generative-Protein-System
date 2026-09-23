/**
 * Regression: the Cron module lists scheduled tasks, a double click opens the
 * task tab with its form renderer, and Save PUTs the task. Prereq:
 * `npm run build -w @science-studio/transport-client`. Chromium-gated.
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

const TASKS = {
  tasks: [
    {
      id: "daily-digest",
      name: "Daily digest",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "Summarize.",
      path: ".science-studio/cron/daily-digest.md",
    },
  ],
  invalid: [],
};

test(
  "the Cron panel lists tasks and opens the editor tab",
  { timeout: 240_000 },
  async (t) => {
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found");
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

      const puts = [];
      const isCronRequest = (url) =>
        url.pathname === "/api/cron" || url.pathname.startsWith("/api/cron/");
      await page.route("**/api/workspace/file*", (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("path") === ".science-studio/cron/daily-digest.log.md") {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: "## 2026-09-18T09:00:00.000Z · success\n- session: s1\n- run: run-1\n\nDigest complete.\n",
          });
        }
        return route.fallback();
      });
      await page.route(isCronRequest, (route) => {
        const request = route.request();
        if (request.method() === "PUT") puts.push(request.url());
        if (request.url().includes("/task?")) {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: TASKS.tasks[0] }),
          });
        }
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(TASKS),
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const cron = page.locator('[data-section="cron"]');
      await cron.getByRole("button", { name: "Cron" }).click();
      const row = cron.getByText("Daily digest");
      await row.waitFor({ timeout: 10_000 });
      await cron.getByText("Every day at 09:00").waitFor({ timeout: 10_000 });

      await row.dblclick();
      const tab = page.getByRole("tab", { name: /Daily digest/ });
      await tab.waitFor({ timeout: 10_000 });
      await page.getByLabel("Schedule preset").waitFor({ timeout: 10_000 });
      await page.getByText("Recent runs").waitFor({ timeout: 10_000 });
      await page.getByText("Digest complete.").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(500);
      assert.ok(puts.length >= 1, "Save PUTs the task");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);

test(
  "the Cron run log is read from the Project's main worktree, not the active checkout",
  { timeout: 240_000 },
  async (t) => {
    /**
     * Cron is Project-`main`-only: the service scheduler and the `/api/cron*`
     * routes read `.science-studio/cron/` from the Project root. The renderer's
     * run-log read must therefore pin `main` explicitly — the workspace provider
     * would otherwise fall back to the ACTIVE worktree (docs/adr/0025), so a
     * `main` cron task opened while scoped to a linked checkout showed an
     * empty/404 log.
     */
    const executablePath = findChromium();
    if (!executablePath) {
      t.skip("no Chromium found");
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

      // Observe the exact run-log request the renderer issues.
      const logRequests = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname.endsWith("/api/workspace/file") &&
          url.searchParams.get("path") === ".science-studio/cron/daily-digest.log.md"
        ) {
          logRequests.push(url);
        }
      });
      await page.route("**/api/workspace/file*", (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("path") === ".science-studio/cron/daily-digest.log.md") {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/plain" },
            body: "## 2026-09-18T09:00:00.000Z · success\n- session: s1\n- run: run-1\n\nDigest complete.\n",
          });
        }
        return route.fallback();
      });
      const isCronRequest = (url) =>
        url.pathname === "/api/cron" || url.pathname.startsWith("/api/cron/");
      await page.route(isCronRequest, (route) => {
        if (route.request().url().includes("/task?")) {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: TASKS.tasks[0] }),
          });
        }
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(TASKS),
        });
      });

      // Boot scoped to a LINKED worktree (`exp-a`), not `main`.
      await page.goto(`http://localhost:${port}/projects/p1/worktrees/exp-a/sessions/s-exp`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const cron = page.locator('[data-section="cron"]');
      await cron.getByRole("button", { name: "Cron" }).click();
      const row = cron.getByText("Daily digest");
      await row.waitFor({ timeout: 10_000 });
      await row.dblclick();
      await page.getByText("Recent runs").waitFor({ timeout: 10_000 });
      await page.getByText("Digest complete.").waitFor({ timeout: 10_000 });

      assert.ok(logRequests.length >= 1, "the run-log file must be read");
      assert.equal(
        logRequests[0].searchParams.get("worktreeId"),
        "main",
        "the Cron run log must be read from the Project's main worktree, not the active checkout",
      );

      // "Open log" opens the log as a PLAIN file tab, whose generic preview
      // reads with the ACTIVE worktree unless the path is pinned. Assert the
      // tab's own read also names `main`: register the waiter before the click
      // so it can only match the request the click causes.
      const openedLogRequest = page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          return (
            url.pathname.endsWith("/api/workspace/file") &&
            url.searchParams.get("path") === ".science-studio/cron/daily-digest.log.md"
          );
        },
        { timeout: 10_000 },
      );
      await page.getByRole("button", { name: "Open log" }).click();
      const openedLog = await openedLogRequest;
      assert.equal(
        new URL(openedLog.url()).searchParams.get("worktreeId"),
        "main",
        "the log opened as a file tab must also read the Project's main worktree",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
