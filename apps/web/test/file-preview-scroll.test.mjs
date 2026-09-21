/**
 * Regression: a file preview taller than its pane must scroll.
 *
 * The renderers' contract, whatever shape a renderer takes: the content lives
 * in a bounded, scrollable box — either because the renderer IS the container
 * (plain text: the `flex-1 overflow-auto` pre) or because its scrollable
 * wrapper is (highlighted code: a shiki block inside the pane's `flex-1
 * overflow-auto` div). The failure this guards against is the box GROWING to
 * the content's full height in an unbounded parent: nothing scrolls and the
 * tail is silently clipped out of reach.
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

/**
 * Walk up from `el` to the nearest bounding scroll container, and report
 * whether scrolling to the bottom actually reveals new content.
 */
const findContainer = (el) => {
  let node = el;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
      node.scrollTop = node.scrollHeight;
      return {
        tag: node.tagName,
        className: String(node.className).slice(0, 80),
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        scrolled: node.scrollTop,
      };
    }
    node = node.parentElement;
  }
  return null;
};

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

      const box = await pre.evaluate(findContainer);
      assert.ok(
        box !== null,
        "no bounding scroll container anywhere above the content — the preview " +
          "grows to the file's full height and the tail is unreachable",
      );
      assert.ok(
        box.clientHeight < box.scrollHeight,
        `the container must be bounded, got clientHeight=${box.clientHeight}, scrollHeight=${box.scrollHeight}`,
      );
      assert.ok(box.scrolled > 0, "the preview must actually scroll to reveal the clipped tail");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
