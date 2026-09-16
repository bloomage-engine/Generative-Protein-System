/**
 * Regression: a file preview taller than its pane must scroll.
 *
 * The center preview pane renders each text file through a renderer whose root
 * is `flex-1 overflow-auto` — a contract that only holds when the renderer's
 * parent is a flex COLUMN of bounded height. When that wrapper is a plain block
 * with `overflow-hidden`, `flex-1` is a no-op, the renderer grows to its full
 * content height, and the pane silently CLIPS the tail: nothing scrolls and the
 * overflow is unreachable. This test opens a long file and asserts the renderer
 * is actually scrollable.
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

const LONG_BODY = Array.from({ length: 300 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join(
  "\n",
);

test(
  "an overflowing file preview scrolls instead of clipping",
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
      // Registered after the harness mock (most recent route wins): serve a file
      // tall enough that it cannot fit the pane.
      await page.route("**/api/workspace/file*", (route) =>
        route.fulfill({ status: 200, headers: { "content-type": "text/plain" }, body: LONG_BODY }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // The right pane is open on load; clicking a file opens it in the center.
      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      await tree.getByRole("treeitem", { name: "notes.txt" }).click();
      await page.getByText("/notes.txt", { exact: true }).waitFor({ timeout: 15_000 });

      const pre = page.locator("pre").filter({ hasText: "line-000" });
      await pre.waitFor({ timeout: 15_000 });

      const metrics = await pre.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      assert.ok(
        metrics.scrollHeight > metrics.clientHeight,
        `the preview must be a bounded scroll container, got clientHeight=${metrics.clientHeight}, scrollHeight=${metrics.scrollHeight}`,
      );

      const scrolled = await pre.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
      });
      assert.ok(scrolled > 0, "the preview must actually scroll to reveal the clipped tail");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
