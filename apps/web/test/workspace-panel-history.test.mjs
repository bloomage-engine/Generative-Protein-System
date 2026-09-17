/**
 * Regression: toggling the Right panel must not wipe the chat history.
 *
 * `useTransport` must be called by a component that never re-renders: the
 * assistant-ui transport runtime rebuilds its internal thread-list adapter on
 * every invocation, so a re-render of the owning component reads as an adapter
 * swap — it tears the active thread down and starts an empty one, wiping the
 * transcript, and the mount-time history probe does not re-run, so the
 * conversation stays blank until a reload. `apps/web/app/page.tsx` therefore
 * keeps state out of the runtime-owning `Session` (memoized, state-free) and in
 * `WorkspaceShell` below it. If that structure regresses, clicking the Right
 * panel toggle blanks the thread — this test goes red.
 *
 * The second test guards the same invariant one level up: the left slot holds
 * EITHER the conversation OR the Projects pane (the top bar switches between
 * them), so switching views unmounts and remounts `Thread` off the same runtime
 * — and the Projects pane's own flows (list, switch Project, create
 * Project/Session) must not drag the runtime down with them.
 *
 * The workspace-surface mock lives entirely in the browser (Playwright route
 * interception), so the transport-service and a runtime adapter are NOT needed.
 *
 * Prereq: `npm run build -w @science-studio/transport-client` (the web app
 * imports the client package from its dist build).
 *
 * Needs a Chromium. Resolution order: $PLAYWRIGHT_CHROMIUM_EXECUTABLE, a
 * Playwright browser cache, then the system Chrome. When none is found the test
 * is SKIPPED, not failed, so it does not break a browser-less `npm test`.
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

test(
  "clicking the Right panel toggle keeps the chat history",
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

      // The transport probe reconciles to the full transcript. The route now
      // carries the Project/Session scope in its query, so the glob must allow it.
      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      // The conversation lives at the session route; the URL scopes every
      // request (the page itself fetches no project metadata).
      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(
        await page.getByText(HISTORY_MARKER).count(),
        1,
        "the probe-loaded history must render before the panel opens",
      );

      await page.getByRole("button", { name: "Right panel" }).click();
      await page.locator('[data-section="files"]').waitFor({ state: "detached", timeout: 10_000 });
      await page.waitForTimeout(1_500);

      assert.equal(
        await page.getByText(HISTORY_MARKER).count(),
        1,
        "the user message must survive the Right panel toggle",
      );
      assert.equal(
        await page.getByText("assistant-reply").count(),
        1,
        "the assistant reply must survive the Right panel toggle",
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
  "the Projects pane and the conversation share the left slot without losing history",
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

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);

      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Every panel assertion is scoped to the pane: the status bar also shows
      // the active Session's title, so an unscoped text query would match twice.
      const pane = page.getByRole("complementary", { name: "Projects and sessions" });

      // One slot, two views: the Projects view takes it and the Thread goes.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Alpha", exact: true }).waitFor({ timeout: 15_000 });
      assert.equal(
        await page.getByText(HISTORY_MARKER).count(),
        0,
        "the Projects view must own the left slot",
      );
      assert.equal(
        await pane.getByText("First session").count(),
        1,
        "the active Project's Sessions must be listed under it",
      );

      // Back to the conversation: the Thread remounts off the SAME runtime, so
      // the transcript it already holds must render again.
      await page.getByRole("button", { name: "Conversation", exact: true }).click();
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 15_000 });
      assert.equal(
        await page.getByText("assistant-reply").count(),
        1,
        "the transcript must survive the view switch",
      );

      // Switching Project loads THAT Project's Sessions.
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Beta", exact: true }).click();
      await pane.getByText("Beta session").waitFor({ timeout: 15_000 });

      // A new Project with no Session must keep the chrome — the pane is where
      // its first Session gets created.
      await pane.getByRole("button", { name: "New project" }).click();
      await page.getByPlaceholder("Project name").fill("Gamma");
      await pane.getByRole("button", { name: "Create", exact: true }).click();
      await pane.getByRole("button", { name: "Gamma", exact: true }).waitFor({ timeout: 15_000 });
      assert.equal(
        await pane.getByText("No sessions yet.").count(),
        1,
        "a Project with no Session stays in the pane",
      );

      // ... and the Session it creates opens the conversation on it.
      await pane.getByRole("button", { name: "New session" }).click();
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(
        await page.getByText(HISTORY_MARKER).count(),
        1,
        "the new Session's probe must render its transcript",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
