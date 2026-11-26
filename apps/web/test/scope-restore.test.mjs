/**
 * Regression: a load must resume the scope this browser last worked in — the
 * Project, its Worktree and the Session — and must never open an id the record
 * does not list (docs/adr/0009, 0025).
 *
 * The scope is a claim until `/api/projects*` and `/api/worktrees*` answer — the
 * transport route MINTS a Project/Session row for an unknown key instead of
 * refusing it, so probing a stale id fabricates the very row it claims to
 * resume. That is why the seeding effect resolves the whole scope BEFORE the
 * runtime mounts, and why every assertion here is made on what the client
 * actually asked for (the transport POST's URL and the session-fetch URLs), not
 * on what it rendered.
 *
 * The service surfaces are mocked in the browser, so no transport-service,
 * runtime adapter or workspace deployment is needed.
 *
 * Prereq: `npm run build -w @gps/transport-client` (the web app
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

const SCOPE_MEMORY_KEY = "gps.scope.v1";

/** A `(Project, Worktree)` Session key: the separator mirrors `scope-memory.ts`. */
const SEP = "\u0000";
const sessionKey = (projectId, worktreeId) => `${projectId}${SEP}${worktreeId}`;

const readScopeMemory = (page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "null"), SCOPE_MEMORY_KEY);

/** Seed the remembered scope before a load — simulating a previous visit. */
const seedMemory = (page, value) =>
  page.evaluate(
    ([key, raw]) => window.localStorage.setItem(key, raw),
    [SCOPE_MEMORY_KEY, JSON.stringify(value)],
  );

/**
 * The scope the client asked the service with — the query is the authoritative
 * half. A missing `worktreeId` reads as `main` (the service's default).
 */
const probedScope = (url) => {
  const query = new URL(url).searchParams;
  return `${query.get("projectId")}/${query.get("worktreeId") ?? "main"}/${query.get("threadId")}`;
};

test(
  "a load resumes the remembered Project/Worktree/Session and never opens an id the record does not list",
  { timeout: 300_000 },
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
      const record = await mockRecordSurface(page);

      const base = `http://localhost:${port}`;

      // Every session LISTING the client asks for, so a fabricated worktree can
      // be proven never opened (the request's `worktreeId`).
      const sessionRequests = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("/api/projects/") && url.includes("/sessions")) sessionRequests.push(url);
      });

      // 1. A legacy two-part deep-link (no worktree segment) opens the Project's
      //    `main` worktree, remembers it, and mirrors the full three-part URL.
      await page.goto(`${base}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(probedScope(transportPosts.at(-1)), "p1/main/s1");
      assert.deepEqual(await readScopeMemory(page), {
        version: 1,
        lastProjectId: "p1",
        worktrees: { p1: "main" },
        sessions: { [sessionKey("p1", "main")]: "s1" },
      });
      assert.equal(new URL(page.url()).pathname, "/projects/p1/worktrees/main/sessions/s1");

      // 2. A remembered `exp-a` worktree is restored on a home load, and its
      //    remembered Session is opened (not `main`'s, not the newest).
      await seedMemory(page, {
        version: 1,
        lastProjectId: "p1",
        worktrees: { p1: "exp-a" },
        sessions: { [sessionKey("p1", "exp-a")]: "s-exp" },
      });
      transportPosts.length = 0;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(
        probedScope(transportPosts[0]),
        "p1/exp-a/s-exp",
        "the remembered worktree's remembered Session must be opened",
      );
      assert.equal(new URL(page.url()).pathname, "/projects/p1/worktrees/exp-a/sessions/s-exp");
      assert.equal((await readScopeMemory(page)).worktrees.p1, "exp-a");

      // 3. A remembered worktree the record no longer lists falls back to `main`
      //    — and is never opened.
      const fullP1 = record.worktrees.byProject.p1;
      record.worktrees.byProject.p1 = [fullP1[0]];
      await seedMemory(page, {
        version: 1,
        lastProjectId: "p1",
        worktrees: { p1: "exp-a" },
        sessions: { [sessionKey("p1", "exp-a")]: "s-exp" },
      });
      transportPosts.length = 0;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(
        probedScope(transportPosts[0]),
        "p1/main/s1",
        "an unlisted remembered worktree must fall back to main",
      );
      assert.equal((await readScopeMemory(page)).worktrees.p1, "main");
      record.worktrees.byProject.p1 = fullP1;

      // 4. A deep-link claiming a worktree the record does not list is
      //    discarded: no session is ever fetched for the fabricated id, and no
      //    probe carries it.
      sessionRequests.length = 0;
      transportPosts.length = 0;
      await page.goto(`${base}/projects/p1/worktrees/exp-gone/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.ok(
        sessionRequests.every((url) => !url.includes("exp-gone")),
        `a fabricated worktree must never be listed, saw ${sessionRequests.join(", ")}`,
      );
      assert.ok(
        transportPosts.every((url) => !url.includes("exp-gone")),
        `a fabricated worktree must never be probed, saw ${transportPosts.join(", ")}`,
      );
      assert.equal(probedScope(transportPosts[0]), "p1/main/s1");

      // 5. Expanding a Project is browsing — the scope does not move — and
      //    DOUBLE-clicking one of its Sessions is what commits it.
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Beta", exact: true }).click();
      await pane.getByText("Beta session").waitFor({ timeout: 15_000 });
      assert.equal(
        new URL(page.url()).pathname,
        "/projects/p1/worktrees/main/sessions/s1",
        "expanding a Project must not move the scope",
      );

      await pane.getByRole("button", { name: "Beta session", exact: true }).dblclick();
      await page.waitForFunction(
        () => location.pathname === "/projects/p2/worktrees/main/sessions/s9",
        { timeout: 15_000 },
      );
      {
        const memory = await readScopeMemory(page);
        assert.equal(memory.lastProjectId, "p2");
        assert.equal(memory.worktrees.p2, "main");
        assert.equal(memory.sessions[sessionKey("p2", "main")], "s9");
      }

      // 6. The SPA home — the surface that used to reset to the first Project —
      //    now resumes the remembered scope, and its FIRST request already
      //    carries it: resolving after probing would mint what it claims to
      //    resume.
      transportPosts.length = 0;
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(probedScope(transportPosts[0]), "p2/main/s9", "the first probe carries the remembered scope");
      assert.ok(
        transportPosts.every((url) => probedScope(url) === "p2/main/s9"),
        `every probe must stay on the remembered scope, saw ${transportPosts.join(", ")}`,
      );
      assert.equal(new URL(page.url()).pathname, "/projects/p2/worktrees/main/sessions/s9");

      // 7. A deep-link into a Project the record does not list is discarded —
      //    it must not be opened (the probe would mint it) and the memory's own
      //    Project takes over. The URL's fabricated worktree goes with it.
      transportPosts.length = 0;
      sessionRequests.length = 0;
      await page.goto(`${base}/projects/p-gone/worktrees/exp-a/sessions/s-gone`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.ok(
        transportPosts.every((url) => !url.includes("p-gone") && !url.includes("s-gone")),
        `a Project the record does not list must never be probed, saw ${transportPosts.join(", ")}`,
      );
      assert.ok(
        sessionRequests.every((url) => !url.includes("p-gone") && !url.includes("exp-a")),
        `an unlisted Project must never list sessions, saw ${sessionRequests.join(", ")}`,
      );
      assert.equal(probedScope(transportPosts[0]), "p2/main/s9");
      assert.equal(new URL(page.url()).pathname, "/projects/p2/worktrees/main/sessions/s9");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
