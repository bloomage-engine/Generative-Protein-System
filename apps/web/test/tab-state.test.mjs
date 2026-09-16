/**
 * Regression: switching tabs must not tear a tab's content down.
 *
 * Every open tab stays MOUNTED (its pane is only hidden with `visibility`), so
 * per-tab state — scroll position today, any future component state — survives a
 * switch. Rendering only the active tab (the old behaviour) remounts on return:
 * the scroll container starts at the top and any inner state is gone. This test
 * scrolls one file, switches to a second, and asserts the first is still mounted,
 * hidden, and at its old scroll offset.
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

const body = (tag) =>
  Array.from({ length: 300 }, (_, i) => `${tag}-line-${String(i).padStart(3, "0")}`).join("\n");

const BODIES = { "a.txt": body("a"), "b.txt": body("b") };

test(
  "switching tabs keeps each tab mounted and preserves its scroll",
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
      // Registered after the harness mocks (most recent route wins): two files,
      // each with a body tall enough to scroll.
      await page.route("**/api/workspace/entries*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "",
            entries: [
              { path: "a.txt", name: "a.txt", kind: "file", size: 10 },
              { path: "b.txt", name: "b.txt", kind: "file", size: 10 },
            ],
          }),
        }),
      );
      await page.route("**/api/workspace/file*", (route) => {
        const path = new URL(route.request().url()).searchParams.get("path") ?? "";
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: BODIES[path] ?? "",
        });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      await tree.getByRole("treeitem", { name: "a.txt" }).click();
      await page.getByText("/a.txt", { exact: true }).waitFor({ timeout: 15_000 });

      const aPre = page.locator("pre").filter({ hasText: "a-line-000" });
      await aPre.waitFor({ timeout: 15_000 });
      const saved = await aPre.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
      });
      assert.ok(saved > 0, "the first tab must scroll before the switch");

      // Switch to b: b becomes visible, a stays mounted but hidden.
      await page.getByRole("tab").filter({ hasText: "b.txt" }).click();
      await page.getByText("/b.txt", { exact: true }).waitFor({ timeout: 15_000 });

      const bPre = page.locator("pre").filter({ hasText: "b-line-000" });
      await bPre.waitFor({ timeout: 15_000 });
      assert.ok(await bPre.isVisible(), "b's content must be visible while active");
      assert.equal(await aPre.count(), 1, "a's pane must stay mounted while inactive");
      assert.equal(await aPre.isVisible(), false, "a's pane must be hidden while inactive");

      // Switch back: a is visible again and still at its old scroll offset.
      await page.getByRole("tab").filter({ hasText: "a.txt" }).click();
      await page.getByText("/a.txt", { exact: true }).waitFor({ timeout: 15_000 });
      assert.ok(await aPre.isVisible(), "a's content must be visible again");
      assert.equal(
        await aPre.evaluate((el) => el.scrollTop),
        saved,
        "a's scroll position must survive the round trip",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
