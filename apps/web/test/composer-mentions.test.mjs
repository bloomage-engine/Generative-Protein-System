/**
 * Regression: the composer `@` picker is a BROWSEABLE workspace picker, and a
 * picked file becomes an inline icon+name chip (docs/adr/0023) while the wire
 * still carries the raw `:file[…]` directive the service lifts.
 *
 * Two invariants:
 *   1. A directory row NAVIGATES (it lists the subdirectory, breadcrumb follows)
 *      instead of inserting a mention; only a file inserts.
 *   2. The inserted file renders as `.aui-mention-chip` and the SENT text still
 *      holds `:file[raw.csv]{name=analysis/data/raw.csv}`.
 *
 * Prereq: `npm run build -w @science-studio/transport-client`.
 * Needs a Chromium; SKIPPED when none is found.
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
  mockWorkbenchSurfaces,
  newWorkbenchPage,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

const ENTRIES = {
  "": [
    { path: "analysis", name: "analysis", kind: "dir", size: 0 },
    { path: "notes.txt", name: "notes.txt", kind: "file", size: 3 },
  ],
  analysis: [
    { path: "analysis/plot.png", name: "plot.png", kind: "file", size: 3 },
    { path: "analysis/data", name: "data", kind: "dir", size: 0 },
  ],
  "analysis/data": [
    { path: "analysis/data/raw.csv", name: "raw.csv", kind: "file", size: 3 },
  ],
};

test(
  "the @ picker browses subdirectories and inserts a file as an inline chip",
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

      // A workspace whose root has a directory to descend into. Registered
      // AFTER the harness (most recent route wins).
      await page.route("**/api/workspace/entries*", (route) => {
        const path = new URL(route.request().url()).searchParams.get("path") ?? "";
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, entries: ENTRIES[path] ?? [] }),
        });
      });

      // Capture the SENT body so the wire-level directive can be asserted.
      const posts = [];
      await page.route("**/api/transport*", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts.push(route.request().postData() ?? "");
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: SNAPSHOT_FRAMES,
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const input = page.locator(".aui-lexical-input").first();
      await input.waitFor({ timeout: 30_000 });
      await input.click();
      await input.pressSequentially("@");

      const menu = page.locator('[data-slot="aui-composer-mention-menu"]');
      await menu.waitFor({ timeout: 15_000 });
      await menu.getByText("analysis", { exact: true }).waitFor({ timeout: 15_000 });
      await menu.getByText("notes.txt", { exact: true }).waitFor({ timeout: 15_000 });

      // Invariant 1: a directory navigates rather than inserting.
      await menu.getByText("analysis", { exact: true }).click();
      await menu.getByText("plot.png", { exact: true }).waitFor({ timeout: 15_000 });
      await page
        .locator('[data-slot="aui-composer-mention-breadcrumb"]')
        .getByText("analysis", { exact: true })
        .waitFor({ timeout: 15_000 });
      assert.equal(
        await page.locator(".aui-mention-chip").count(),
        0,
        "picking a directory must not insert a mention chip",
      );

      // Descend one more level, then walk back up with the synthetic `..` row.
      await menu.getByText("data", { exact: true }).click();
      await menu.getByText("raw.csv", { exact: true }).waitFor({ timeout: 15_000 });
      await menu.getByText("..", { exact: true }).click();
      await menu.getByText("plot.png", { exact: true }).waitFor({ timeout: 15_000 });

      // …and back to the root via the breadcrumb.
      await page
        .locator('[data-slot="aui-composer-mention-breadcrumb"]')
        .getByText("project", { exact: true })
        .click();
      await menu.getByText("notes.txt", { exact: true }).waitFor({ timeout: 15_000 });

      // Invariant 2: a file inserts the inline chip.
      await menu.getByText("analysis", { exact: true }).click();
      await menu.getByText("data", { exact: true }).click();
      await menu.getByText("raw.csv", { exact: true }).click();
      const chip = page.locator(".aui-mention-chip");
      await chip.waitFor({ timeout: 15_000 });
      assert.equal((await chip.innerText()).trim(), "raw.csv");
      assert.equal(await chip.getAttribute("data-directive-type"), "file");

      // The wire still carries the raw directive for the service to lift.
      await input.click();
      await input.press("Enter");
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        !posts.some((p) => p.includes(":file[raw.csv]{name=analysis/data/raw.csv}"))
      ) {
        await page.waitForTimeout(250);
      }
      assert.ok(
        posts.some((p) => p.includes(":file[raw.csv]{name=analysis/data/raw.csv}")),
        `sent body must carry the nested directive; saw: ${posts.join(" | ")}`,
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
