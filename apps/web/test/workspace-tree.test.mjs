/**
 * Regression: the Files pane is a nested, lazy tree, not a one-level list.
 *
 * The tree must render top-level entries as `treeitem`s and must NOT fetch a
 * directory until it is expanded; clicking a file must open it in the center
 * preview. Against the old one-directory-at-a-time browser (which has no
 * `role="tree"`) this test is red.
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

const LISTINGS = {
  "": [
    { path: "notes.txt", name: "notes.txt", kind: "file", size: 3 },
    { path: "src", name: "src", kind: "dir" },
  ],
  src: [{ path: "src/index.ts", name: "index.ts", kind: "file", size: 10 }],
};

test(
  "the workspace tree expands lazily and opens a clicked file",
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

      // Registered after the harness routes (Playwright tries the most recent
      // first), so this per-directory listing wins over the flat default.
      const requestedDirs = [];
      await page.route("**/api/workspace/entries*", async (route) => {
        const url = new URL(route.request().url());
        const path = url.searchParams.get("path") ?? "";
        requestedDirs.push(path);
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, entries: LISTINGS[path] ?? [] }),
        });
      });
      await page.route("**/api/workspace/file*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "index body",
        }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByRole("button", { name: "Files" }).click();

      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      const src = tree.getByRole("treeitem", { name: "src" });
      await src.waitFor({ timeout: 15_000 });

      assert.equal(await src.getAttribute("aria-expanded"), "false");
      assert.equal(
        requestedDirs.includes("src"),
        false,
        "an unexpanded directory must not be fetched",
      );

      await src.click();
      await tree.getByRole("treeitem", { name: "index.ts" }).waitFor({ timeout: 15_000 });
      assert.equal(await src.getAttribute("aria-expanded"), "true");
      assert.ok(requestedDirs.includes("src"), "expanding must load that directory");

      await tree.getByRole("treeitem", { name: "index.ts" }).click();
      await page.getByText("/src/index.ts", { exact: true }).waitFor({ timeout: 15_000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
