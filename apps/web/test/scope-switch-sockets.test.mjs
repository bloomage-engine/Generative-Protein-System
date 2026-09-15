/**
 * Regression: a Project switch must not exhaust the browser's connection pool,
 * and it must drop the previous Project's open files.
 *
 * The standing watch is an NDJSON stream that never ends, and it belongs to the
 * runtime, which is remounted on every scope change (and, in dev, twice per
 * mount by StrictMode). If unmounting does not ABORT the in-flight watch, each
 * switch orphans one connection; the browser allows only ~6 per origin over
 * HTTP/1.1, after which NO request to this origin can start — the session list,
 * the file listing and the mount probe all queue forever and the workbench looks
 * frozen (docs/adr/0009). Hence the two assertions below: the UI drops tabs with
 * the Project, and the ORIGIN stays usable after repeated switching.
 *
 * The watch is deliberately NOT mocked in the browser here (an in-browser mock
 * occupies no socket, so it cannot reproduce this): `startWatchStub` serves it
 * over a real socket and the web server proxies to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  findChromium,
  freePort,
  killTree,
  mockRecordSurface,
  mockWorkbenchSurfaces,
  newWorkbenchPage,
  startWatchStub,
  startWebServer,
  waitForServer,
  warmWorkbench,
} from "./harness.mjs";

/** Enough switching to overflow a ~6-connection-per-origin pool twice over. */
const SWITCHES = 8;

async function withWorkbench(t, opts = {}) {
  const executablePath = findChromium();
  if (!executablePath) {
    t.skip("no Chromium found — set PLAYWRIGHT_CHROMIUM_EXECUTABLE or install one");
    return null;
  }
  const port = await freePort();
  const server = startWebServer(port, opts.env);
  const base = `http://localhost:${port}`;
  await waitForServer(base, 120_000);
  await warmWorkbench(base, { transport: opts.transport });
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath });
  const page = await newWorkbenchPage(browser);
  return {
    base,
    page,
    async done() {
      await browser?.close();
      killTree(server.child, port);
    },
    server,
  };
}

test(
  "switching Project drops the open file tabs, in one root-listing request",
  { timeout: 240_000 },
  async (t) => {
    const bench = await withWorkbench(t);
    if (!bench) return;
    const { base, page, done, server } = bench;
    try {
      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      const workspaceRequests = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/workspace/entries")) {
          workspaceRequests.push(request.url());
        }
      });

      await page.goto(`${base}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Alpha", exact: true }).waitFor({ timeout: 15_000 });

      // Open a file of THIS Project: the tree lists `notes.txt`.
      await page.getByRole("button", { name: /notes\.txt/ }).click();
      await page.getByRole("tab").first().waitFor({ timeout: 15_000 });
      assert.equal(await page.getByRole("tab").count(), 1, "the file must open as a tab");

      // Expanding another Project is only browsing: the scope, the tabs and the
      // file tree all stay where they are.
      workspaceRequests.length = 0;
      await pane.getByRole("button", { name: "Beta", exact: true }).click();
      await pane.getByText("Beta session").waitFor({ timeout: 15_000 });
      assert.equal(
        await page.getByRole("tab").count(),
        1,
        "browsing another Project must not disturb the open files",
      );
      assert.equal(new URL(page.url()).pathname, "/projects/p1/sessions/s1");
      // The tree, the availability chip and the top-bar search all want the root
      // listing; they must share ONE request for it (three separate fetches used
      // to queue behind the per-origin connection pool).
      assert.ok(
        workspaceRequests.length <= 2,
        `one root listing per Project, saw ${workspaceRequests.length}: ${workspaceRequests.join(", ")}`,
      );

      // DOUBLE-clicking a Session is what commits the scope — and a Project
      // switch swaps the workspace under the tabs.
      await pane.getByRole("button", { name: "Beta session", exact: true }).dblclick();
      await page.waitForFunction(() => location.pathname.startsWith("/projects/p2"), {
        timeout: 15_000,
      });
      assert.equal(
        await page.getByRole("tab").count(),
        0,
        "a tab of the previous Project must not survive the switch",
      );
      assert.equal(
        await page.getByText("Open a file from the tree to show tabs").count(),
        1,
        "the strip must be back to its empty state",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await done();
    }
  },
);

test(
  "repeated Project switching keeps the origin reachable",
  { timeout: 300_000 },
  async (t) => {
    const stub = await startWatchStub();
    const bench = await withWorkbench(t, { env: { TRANSPORT_SERVICE_URL: stub.url }, transport: true });
    if (!bench) {
      await stub.close();
      return;
    }
    const { base, page, done, server } = bench;
    const probes = [];
    try {
      // The probe POST and the record/workspace surfaces are mocked; the WATCH is
      // not — it must go to the stub over a real socket, which is the leak's
      // habitat. `/api/transport/commands` stays real too: it is the liveness
      // probe (a small, finite request to this origin).
      await mockWorkbenchSurfaces(page, { watch: false, commands: false });
      await mockRecordSurface(page);

      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      const pane = page.getByRole("complementary", { name: "Projects and sessions" });
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await pane.getByRole("button", { name: "Alpha", exact: true }).waitFor({ timeout: 15_000 });

      const liveness = () =>
        page.evaluate(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          const started = performance.now();
          try {
            const res = await fetch("/api/transport/commands", {
              signal: controller.signal,
              cache: "no-store",
            });
            return { ok: res.ok, ms: Math.round(performance.now() - started) };
          } catch {
            return { ok: false, ms: Math.round(performance.now() - started) };
          } finally {
            clearTimeout(timer);
          }
        });

      // Alternating Sessions of two Projects: each switch remounts the runtime
      // (and so its watch), which is what used to orphan a connection per swap.
      // A committed Session brings the conversation back, so the pane is
      // reopened — when it is closed — each round (that button is a TOGGLE).
      const sessionsByProject = { Alpha: "First session", Beta: "Beta session" };
      for (let i = 1; i <= SWITCHES; i++) {
        const project = i % 2 === 1 ? "Beta" : "Alpha";
        if (!(await pane.isVisible())) {
          await page.getByRole("button", { name: "Projects", exact: true }).click();
        }
        const row = pane.getByRole("button", { name: project, exact: true });
        await row.waitFor({ timeout: 15_000 });
        await row.click(); // expand (browsing)
        const session = pane.getByRole("button", { name: sessionsByProject[project], exact: true });
        await session.waitFor({ timeout: 15_000 });
        await session.dblclick(); // commit
        await page.waitForTimeout(700);
        probes.push({ switch: i, project, ...(await liveness()) });
      }

      const dead = probes.filter((probe) => !probe.ok);
      assert.deepEqual(
        dead,
        [],
        `every same-origin request must still start — ${dead.length}/${SWITCHES} timed out ` +
          `(orphaned watches at the stub: ${stub.openWatches()}, requests: ${JSON.stringify(probes)})`,
      );

      // ... and the page must still be able to navigate (the user's symptom: a
      // reload that can never load anything again).
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // No accumulation: one watch belongs to the live page, plus at most one
      // still tearing down. A leak leaves ~one per switch (the stub saw 6 after
      // two switches before this was fixed), so the margin is wide on purpose —
      // the number itself is a diagnostic, not a guarantee about the proxy.
      const orphans = stub.openWatches();
      assert.ok(
        orphans <= 2,
        `${SWITCHES} switches left ${orphans} watch connections open at the stub`,
      );
    } catch (error) {
      throw new Error(
        `${error.message}\n--- probes ---\n${JSON.stringify(probes)}\n--- web server log ---\n${server.log().slice(-2000)}`,
      );
    } finally {
      await done();
      await stub.close();
    }
  },
);
