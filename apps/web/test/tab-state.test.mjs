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
 * Prereq: `npm run build -w @gps/transport-client`.
 * Needs a Chromium; SKIPPED when none is found.
 *
 * The third test pins the scope half of the same contract: an open tab belongs
 * to its checkout, so a Worktree switch (a new `worktreeId` scope, docs/adr/0025)
 * clears the tabs while a same-worktree Session switch keeps them.
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

/** A 1×1 transparent PNG — small enough to serve from a route mock. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

      // The scroll contract: the content lives in a bounded, scrollable box —
      // the renderer's own `pre` for plain text, or the shiki block's wrapper
      // div for code-kind files (a `.txt` is code-kind, so the box measured here
      // is the nearest scrolled ancestor, not the `pre` itself).
      const saved = await aPre.evaluate((el) => {
        let node = el;
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
            node.scrollTop = node.scrollHeight;
            return node.scrollTop;
          }
          node = node.parentElement;
        }
        return 0;
      });
      assert.ok(saved > 0, "the first tab's preview must be a bounded scrollable box");

      // Switch to b: the tab strip lists only OPENED files, so open b from the
      // tree first (its tab appears); b becomes visible, a stays mounted but
      // hidden.
      await tree.getByRole("treeitem", { name: "b.txt" }).click();
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
        await aPre.evaluate((el) => {
          let node = el;
          while (node && node !== document.body) {
            const cs = getComputedStyle(node);
            if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) {
              return node.scrollTop;
            }
            node = node.parentElement;
          }
          return -1;
        }),
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

test(
  "an image in an INACTIVE tab stays hidden: a child must not re-assert visibility",
  { timeout: 240_000 },
  async (t) => {
    /**
     * TabPanes hide inactive tabs with `visibility:hidden` (keeping their
     * mounts and scroll). CSS lets a child with its own `visibility:visible`
     * OVERRIDE that ancestor hiding — a renderer that asserts visibility on a
     * loaded element (e.g. an `<img>` flipping hidden→visible on `onLoad`)
     * resurrects inside the hidden pane and covers the active tab. This test
     * pins the mechanism: once its tab is inactive, the image's COMPUTED
     * visibility must be `hidden`, exactly like any other renderer.
     */
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
      await page.route("**/api/workspace/entries*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "",
            entries: [
              { path: "a.txt", name: "a.txt", kind: "file", size: 10 },
              { path: "pic.png", name: "pic.png", kind: "file", size: 70 },
            ],
          }),
        }),
      );
      await page.route("**/api/workspace/file*", (route) => {
        const path = new URL(route.request().url()).searchParams.get("path") ?? "";
        if (path === "pic.png") {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "image/png" },
            body: TINY_PNG,
          });
        }
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

      // Open the image (ACTIVE: visible), and wait until the browser actually
      // decoded it — that is when a renderer that asserts its own visibility
      // would flip to `visible`.
      const img = page.getByAltText("pic.png");
      await tree.getByRole("treeitem", { name: "pic.png" }).click();
      await page.getByText("/pic.png", { exact: true }).waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        (alt) => document.querySelector(`img[alt="${alt}"]`)?.complete === true,
        "pic.png",
        { timeout: 15_000 },
      );
      assert.equal(
        await img.evaluate((el) => getComputedStyle(el).visibility),
        "visible",
        "the image must be visible while its tab is active",
      );

      // Switch to a.txt: the image pane stays MOUNTED (count 1) but its image
      // must inherit the pane's `visibility:hidden` — its computed visibility
      // must be `hidden`, never an element-asserted `visible`.
      await tree.getByRole("treeitem", { name: "a.txt" }).click();
      await page.getByText("/a.txt", { exact: true }).waitFor({ timeout: 15_000 });

      assert.equal(await img.count(), 1, "the image pane must stay mounted while inactive");
      assert.equal(
        await img.evaluate((el) => getComputedStyle(el).visibility),
        "hidden",
        "a loaded image in an inactive tab must stay hidden (no child visibility override)",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);

test(
  "a worktree switch clears the tabs; a same-worktree Session switch keeps them",
  { timeout: 240_000 },
  async (t) => {
    /**
     * The scope now has a Worktree part (docs/adr/0025). An open file belongs to
     * the checkout it was opened under, so a Worktree switch must clear the tabs
     * exactly like a Project switch — while moving between Sessions of the SAME
     * checkout only changes the conversation and keeps them.
     */
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

      // Observe the tree's directory fetch: it must name THIS checkout.
      const entriesRequests = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/workspace/entries")) entriesRequests.push(request.url());
      });

      // Boot straight into the non-default Worktree `exp-a` of Alpha.
      await page.goto(`http://localhost:${port}/projects/p1/worktrees/exp-a/sessions/s-exp`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Open a file of THIS checkout.
      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      assert.ok(
        entriesRequests.some(
          (url) => new URL(url).searchParams.get("worktreeId") === "exp-a",
        ),
        `the file tree must list exp-a's checkout, saw: ${entriesRequests.join(", ")}`,
      );
      await tree.getByRole("treeitem", { name: "notes.txt" }).click();
      await page.getByText("/notes.txt", { exact: true }).waitFor({ timeout: 15_000 });
      assert.equal(await page.getByRole("tab").count(), 1, "the file must open as a tab");

      // Switching to another Session of the SAME Worktree moves only the
      // conversation: the checkout (and so the tabs) stays put.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      const second = pane.getByRole("button", { name: "Experiment two", exact: true });
      await second.waitFor({ timeout: 15_000 });
      await second.dblclick();
      await page.waitForFunction(
        () => location.pathname === "/projects/p1/worktrees/exp-a/sessions/s-exp-2",
        { timeout: 15_000 },
      );
      assert.equal(
        await page.getByRole("tab").count(),
        1,
        "a same-worktree Session switch must keep the open files",
      );

      // Selecting `main` swaps the workspace under the tabs, so they go.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      const main = pane.getByTitle("Open worktree main");
      await main.waitFor({ timeout: 15_000 });
      await main.click();
      await page.waitForFunction(() => location.pathname === "/", { timeout: 15_000 });
      assert.equal(
        await page.getByRole("tab").count(),
        0,
        "a worktree switch must drop the previous checkout's tabs",
      );
      assert.equal(
        await page.getByText("Open a file from the tree to show tabs").count(),
        1,
        "the strip must be back to its empty state",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);

test(
  "creating a Session under a linked worktree files it under that worktree",
  { timeout: 240_000 },
  async (t) => {
    /**
     * A Session carries a `worktreeId` in the create POST's JSON BODY
     * (docs/adr/0025), not its query. This drives the panel's "New session"
     * affordance under the expanded `exp-a` checkout and pins that the APP sends
     * that worktree in the body and commits the new Session under it — an
     * app-side guard. It does not exercise the harness's own body parsing; the
     * mocked record surface would mint `main` regardless and the assertion
     * would still pass.
     */
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

      const sessionPosts = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          request.method() === "POST" &&
          url.pathname === "/api/projects/p1/sessions"
        ) {
          sessionPosts.push(request.postData() ?? "");
        }
      });

      // Boot scoped to the linked `exp-a` checkout.
      await page.goto(`http://localhost:${port}/projects/p1/worktrees/exp-a/sessions/s-exp`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // The active Project is expanded on its active worktree, so the `exp-a`
      // SessionList carries the "New session" affordance.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await pane.getByText("Experiment session").waitFor({ timeout: 15_000 });
      await pane.getByRole("button", { name: "New session" }).click();

      // The new Session commits under `exp-a`...
      await page.waitForFunction(
        () => location.pathname === "/projects/p1/worktrees/exp-a/sessions/s-new",
        { timeout: 15_000 },
      );
      // ... and the create POST itself named that worktree in its body.
      assert.equal(sessionPosts.length, 1, "exactly one create-session POST");
      assert.equal(
        JSON.parse(sessionPosts[0]).worktreeId,
        "exp-a",
        "the create-session POST must carry the active linked worktree",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
