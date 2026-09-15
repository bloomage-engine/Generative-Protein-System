/**
 * Regression: a load must resume the scope this browser last worked in, and must
 * never open an id the record does not list (docs/adr/0009).
 *
 * The scope is a claim until `/api/projects*` answers — the transport route MINTS
 * a Project/Session row for an unknown key instead of refusing it, so probing a
 * stale id fabricates the very row it claims to resume. That is why the seeding
 * effect resolves the scope BEFORE the runtime mounts, and why every assertion
 * here is made on what the client actually asked for (the transport POST's URL),
 * not on what it rendered.
 *
 * The service surfaces are mocked in the browser, so no transport-service,
 * runtime adapter or workspace deployment is needed.
 *
 * Prereq: `npm run build -w @science-studio/transport-client` (the web app
 * imports the client package from its dist build).
 *
 * Needs a Chromium (same resolution as `workspace-panel-history.test.mjs`);
 * SKIPPED, not failed, when none is found.
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

const SCOPE_MEMORY_KEY = "science-studio.scope.v1";

const readScopeMemory = (page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"), SCOPE_MEMORY_KEY);

/** The scope the client asked the service with — the query is the authoritative half. */
const probedScope = (url) => {
  const query = new URL(url).searchParams;
  return `${query.get("projectId")}/${query.get("threadId")}`;
};

test(
  "a load resumes the remembered scope and never opens an id the record does not list",
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

      const { transportPosts } = await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      const base = `http://localhost:${port}`;

      // 1. A deep-link opens its own scope and is remembered, and the URL it
      //    already has is left alone.
      await page.goto(`${base}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(probedScope(transportPosts.at(-1)), "p1/s1");
      assert.deepEqual(await readScopeMemory(page), {
        version: 1,
        lastProjectId: "p1",
        sessions: { p1: "s1" },
      });
      assert.equal(new URL(page.url()).pathname, "/projects/p1/sessions/s1");

      // 2. Expanding a Project is browsing — the scope does not move — and
      //    DOUBLE-clicking one of its Sessions is what commits it. The scope
      //    left behind is p2/s9, while p1's memory stays.
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Beta", exact: true }).click();
      await pane.getByText("Beta session").waitFor({ timeout: 15_000 });
      assert.equal(
        new URL(page.url()).pathname,
        "/projects/p1/sessions/s1",
        "expanding a Project must not move the scope",
      );

      await pane.getByRole("button", { name: "Beta session", exact: true }).dblclick();
      await page.waitForFunction(
        () => location.pathname === `/projects/p2/sessions/s9`,
        { timeout: 15_000 },
      );
      assert.deepEqual(await readScopeMemory(page), {
        version: 1,
        lastProjectId: "p2",
        sessions: { p1: "s1", p2: "s9" },
      });

      // 3. The SPA home — the surface that used to reset to the first Project —
      //    now resumes the remembered scope, and its FIRST request already
      //    carries it: resolving after probing would mint what it claims to
      //    resume.
      transportPosts.length = 0;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(probedScope(transportPosts[0]), "p2/s9", "the first probe carries the remembered scope");
      assert.ok(
        transportPosts.every((url) => probedScope(url) === "p2/s9"),
        `every probe must stay on the remembered scope, saw ${transportPosts.join(", ")}`,
      );
      assert.equal(new URL(page.url()).pathname, "/projects/p2/sessions/s9");

      // 4. A deep-link into a Project the record does not list is discarded —
      //    it must not be opened (the probe would mint it) and the memory's own
      //    Project takes over.
      transportPosts.length = 0;
      await page.goto(`${base}/projects/p-gone/sessions/s-gone`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.ok(
        transportPosts.every((url) => !url.includes("p-gone") && !url.includes("s-gone")),
        `a Project the record does not list must never be probed, saw ${transportPosts.join(", ")}`,
      );
      assert.equal(probedScope(transportPosts[0]), "p2/s9");
      assert.equal(new URL(page.url()).pathname, "/projects/p2/sessions/s9");
      assert.deepEqual(await readScopeMemory(page), {
        version: 1,
        lastProjectId: "p2",
        sessions: { p1: "s1", p2: "s9" },
      });
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
