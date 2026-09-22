/**
 * Regression: the Jobs panel (docs/adr/0024) renders the Compute Job ledger,
 * a row double-clicks into the synthetic `hpc:<jobId>` detail/log tab (which
 * fetches the row and one bounded log tail), the Cancel gesture reaches the
 * service, and Settings → HPC opens the endpoints editor. All HTTP is mocked
 * (the harness's `/api/hpc` stub is overridden here with seeded rows), so no
 * cluster or transport-service is needed.
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

const RUNNING = {
  id: "cjob-run-1",
  projectId: "p1",
  endpointId: "cluster-a",
  kind: "slurm",
  remoteJobId: "4242",
  name: "md run",
  script: "#!/bin/bash\necho hi\n",
  resources: { partition: "gpu", nodes: 2 },
  state: "running",
  remoteDir: "~/science-studio/p1/.ss-jobs/cjob-run-1",
  submittedAt: "2026-09-22T09:00:00.000Z",
  startedAt: "2026-09-22T09:01:00.000Z",
  updatedAt: "2026-09-22T09:05:00.000Z",
};

const DONE = {
  ...RUNNING,
  id: "cjob-done-1",
  remoteJobId: "4200",
  name: "old fold",
  state: "completed",
  exitCode: 0,
  finishedAt: "2026-09-21T12:00:00.000Z",
};

test(
  "the Jobs panel lists the ledger, opens a detail tab, and Settings shows the HPC tab",
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
    const seenPosts = [];
    try {
      await waitForServer(`http://localhost:${port}`, 120_000);
      await warmWorkbench(`http://localhost:${port}`);

      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath });
      const page = await newWorkbenchPage(browser);
      await mockWorkbenchSurfaces(page);
      await mockRecordSurface(page);

      // Seeded HPC surface (registered after the harness stub → wins).
      await page.route((url) => url.pathname.startsWith("/api/hpc/"), (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        if (request.method() === "POST") seenPosts.push(pathname);
        const json = (body, status = 200) =>
          route.fulfill({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (pathname === "/api/hpc/jobs") return json({ jobs: [RUNNING, DONE] });
        if (pathname === `/api/hpc/jobs/${RUNNING.id}/logs`) return json({ text: "step 1 done\n" });
        if (pathname === `/api/hpc/jobs/${RUNNING.id}/cancel`) {
          return json({ job: { ...RUNNING, state: "cancelled", finishedAt: "2026-09-22T09:06:00.000Z" } });
        }
        if (pathname === `/api/hpc/jobs/${RUNNING.id}`) return json({ job: RUNNING });
        return json({ jobs: [], endpoints: [], bound: false });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Expand Jobs: both ledger rows render, open-first, with their meta.
      const jobs = page.locator('[data-section="jobs"]');
      await jobs.getByRole("button", { name: "Jobs", exact: true }).click();
      await jobs.getByText("md run").waitFor({ timeout: 15_000 });
      await jobs.getByText("old fold").waitFor({ timeout: 15_000 });
      assert.ok(await jobs.getByText("#4242").first().isVisible());
      assert.ok(await jobs.getByText("cluster-a").first().isVisible());

      // Cancel offers itself only on the open row and reaches the service.
      // (`exact`: the row's own accessible name embeds the button's aria-label,
      // so a substring match would hit both.)
      page.on("dialog", (dialog) => void dialog.accept());
      await jobs.getByRole("button", { name: "Cancel md run", exact: true }).click();
      const cancelPath = `/api/hpc/jobs/${RUNNING.id}/cancel`;
      const until = Date.now() + 5_000;
      while (!seenPosts.includes(cancelPath) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(seenPosts.includes(cancelPath), `cancel POST seen, got ${JSON.stringify(seenPosts)}`);

      // Double-click → the synthetic hpc:<id> tab: details + one log tail.
      await jobs.getByText("md run").first().dblclick();
      await page.getByText("cluster-a (slurm)").waitFor({ timeout: 15_000 });
      await page.getByText("step 1 done").waitFor({ timeout: 15_000 });
      await page.getByText("#4242").first().waitFor({ timeout: 15_000 });

      // Settings → HPC smoke: the tab exists and the endpoints editor renders.
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("tab", { name: "HPC" }).click();
      await page.getByRole("heading", { name: "HPC Endpoints" }).waitFor({ timeout: 15_000 });
      await page.keyboard.press("Escape");
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
