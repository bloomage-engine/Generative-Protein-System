/**
 * Regression: the right pane stacks four collapsible modules (Files,
 * Subagents, Cron, Jobs). Files is open by default and holds the tree; the
 * other three start collapsed, expand to an empty state, and are resizable by
 * dragging their handle. Collapsing Files unmounts the tree; re-expanding
 * restores it.
 *
 * Prereq: `npm run build -w @gps/transport-client`.
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

test(
  "the right pane stacks collapsible Files, Subagents, Cron and Jobs sections",
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

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Files is open by default, so the tree is already mounted.
      const tree = page.getByRole("tree");
      await tree.waitFor({ timeout: 30_000 });
      await page.locator('[data-section="files"]').waitFor({ timeout: 15_000 });

      const subagents = page.locator('[data-section="subagents"]');
      const cron = page.locator('[data-section="cron"]');
      const jobs = page.locator('[data-section="jobs"]');
      await subagents.waitFor({ timeout: 15_000 });
      await cron.waitFor({ timeout: 15_000 });
      await jobs.waitFor({ timeout: 15_000 });

      // The three non-Files modules start collapsed: headers present, copy absent.
      assert.equal(
        await subagents.getByRole("button", { name: "Subagents" }).getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await cron.getByRole("button", { name: "Cron" }).getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await jobs.getByRole("button", { name: "Jobs", exact: true }).getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(await subagents.getByText("No subagents yet.").count(), 0);
      assert.equal(await cron.getByText("No scheduled tasks.").count(), 0);
      assert.equal(await jobs.getByText("No Compute Jobs.").count(), 0);

      // Expanding reveals the empty state.
      await subagents.getByRole("button", { name: "Subagents" }).click();
      await subagents.getByText("No subagents yet.").waitFor({ timeout: 10_000 });
      await cron.getByRole("button", { name: "Cron" }).click();
      await cron.getByText("No scheduled tasks.").waitFor({ timeout: 10_000 });

      // Dragging the Subagents handle up grows that section.
      const before = await subagents.boundingBox();
      const handle = page.getByRole("separator", { name: "Resize Subagents" });
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 8 });
      await page.mouse.up();
      const after = await subagents.boundingBox();
      assert.ok(
        after.height >= before.height + 40,
        `expected the section to grow, got ${before.height} -> ${after.height}`,
      );

      // The drag is clamped to the space the other modules leave, so the
      // sections can never sum past the pane.
      const pane = page.locator("aside").filter({ has: page.locator('[data-section="files"]') });
      const paneBox = await pane.boundingBox();
      const filesBox = await page.locator('[data-section="files"]').boundingBox();
      assert.ok(
        filesBox.height + after.height <= paneBox.height,
        `sections must stay within the pane, got ${filesBox.height} + ${after.height} > ${paneBox.height}`,
      );

      // The Cron handle sits on the edge BETWEEN Subagents and Cron, so it must
      // trade space only between those two — Files (the top module) must never
      // reflow. (Regression: it once resized Cron and stole that space from
      // Files, making the top module jump.)
      const files0 = (await page.locator('[data-section="files"]').boundingBox()).height;
      const cron0 = (await cron.boundingBox()).height;
      const sub0 = (await subagents.boundingBox()).height;
      const cronHandle = page.getByRole("separator", { name: "Resize Cron" });
      const cbox = await cronHandle.boundingBox();
      await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2 - 60, { steps: 8 });
      await page.mouse.up();
      const files1 = (await page.locator('[data-section="files"]').boundingBox()).height;
      const cron1 = (await cron.boundingBox()).height;
      const sub1 = (await subagents.boundingBox()).height;
      assert.ok(
        Math.abs(files1 - files0) <= 1,
        `the Subagents/Cron edge must not resize Files, got ${files0} -> ${files1}`,
      );
      assert.ok(
        cron1 >= cron0 + 40,
        `expected Cron to grow off the dragged edge, got ${cron0} -> ${cron1}`,
      );
      assert.ok(
        sub1 <= sub0 - 20,
        `expected Subagents to give up the space, got ${sub0} -> ${sub1}`,
      );

      // The Jobs section (docs/adr/0024) expands like its siblings — and only
      // NOW (the drags above kept their exact clamp arithmetic). (`exact`
      // because the Refresh button's accessible name also contains "jobs".)
      await jobs.getByRole("button", { name: "Jobs", exact: true }).click();
      await jobs.getByText("No Compute Jobs.").waitFor({ timeout: 10_000 });

      // Collapsing Files unmounts the tree; re-expanding restores it.
      await page.getByRole("button", { name: "Files" }).click();
      await tree.waitFor({ state: "detached", timeout: 10_000 });
      await page.getByRole("button", { name: "Files" }).click();
      await page.getByRole("tree").waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child, port);
    }
  },
);
