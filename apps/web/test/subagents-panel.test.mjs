/**
 * Regression: the Subagents module renders the live subagent list polled from
 * `/api/transport/subagents`, shows its empty state when the list is empty, and
 * makes no request while collapsed.
 *
 * Prereq: `npm run build -w @gps/transport-client`.
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

      // p1 gets a SECOND session, so the drill-in can be tested across a
      // Session switch (a later-registered route wins over the harness's).
      const record = (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/projects/, "");
        if (path === "/p1/sessions") {
          return route.fulfill({
            json: {
              sessions: [
                { id: "s1", title: "First session" },
                { id: "s2", title: "Second session" },
              ],
            },
          });
        }
        return route.fallback();
      };
      await page.route("**/api/projects", record);
      await page.route("**/api/projects/**", record);

      // The child-2 record belongs to s1 (its ledger's session): the service
      // only serves a child under the session that owns it, so the mock
      // answers 404 for any other threadId claim.
      await page.route("**/api/transport/subagents/child-2/transcript*", (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("threadId") !== "s1") {
          return route.fulfill({ status: 404, headers: { "content-type": "application/json" } });
        }
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transcript: {
              id: "child-2",
              parentId: "s1",
              provider: "fork",
              startedAt: "2026-09-17T00:00:00.000Z",
              finishedAt: "2026-09-17T00:01:00.000Z",
              status: "completed",
              messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "Child transcript body." }] }],
            },
          }),
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

      // Expanding starts polling; the DEFAULT view is the recent window
      // (running always shown + the recent finished ones — not running-only).
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("Literature review").waitFor({ timeout: 10_000 });
      await subagents.getByText("Running").waitFor({ timeout: 10_000 });
      assert.equal(await subagents.getByText("Completed", { exact: true }).count(), 0, "history is hidden by default");
      assert.ok(requests >= 1, "an open Subagents module polls");

      // The History toggle reveals past runs, with a friendly name for the
      // unlabeled child.
      await subagents.getByLabel("Show past subagent runs").click();
      await subagents.getByText("Completed", { exact: true }).waitFor({ timeout: 10_000 });
      const friendly = subagents.getByText("Subagent B", { exact: true });
      await friendly.waitFor({ timeout: 10_000 });

      // Double-clicking a row opens the child session in the tab system.
      // The tab's Result section echoes the final assistant text, so assert
      // inside the TRANSCRIPT's assistant section (page-wide would be 2).
      await friendly.dblclick();
      const transcriptBody = page
        .locator("section")
        .filter({ hasText: "assistant" })
        .getByText("Child transcript body.");
      await transcriptBody.waitFor({ timeout: 10_000 });

      // Switching to ANOTHER Session of the same Project must not blank the
      // open child tab: the tab keeps the Session it was opened in (the record
      // is session-scoped, the tab strip is project-scoped).
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      const secondSession = pane.getByRole("button", { name: "Second session", exact: true });
      // Expand p1 (Alpha) only if it isn't already listing its sessions — a
      // click toggles, so an already-expanded list would collapse.
      if ((await secondSession.count()) === 0) {
        await pane.getByRole("button", { name: "Alpha", exact: true }).click();
      }
      await secondSession.waitFor({ state: "visible", timeout: 15_000 });
      await secondSession.dblclick();
      // The committed scope is the three-part worktree URL: a legacy two-part
      // link resolves to the Project's `main` worktree and is mirrored to that
      // route, so a Session switch inside `main` nests the worktree segment
      // (docs/adr/0025).
      await page.waitForFunction(
        () => location.pathname === `/projects/p1/worktrees/main/sessions/s2`,
        { timeout: 15_000 },
      );
      await transcriptBody.waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
