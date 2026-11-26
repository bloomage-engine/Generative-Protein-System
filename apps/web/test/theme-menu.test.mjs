/**
 * The top bar's theme menu: one dropdown that switches BOTH the light/dark
 * appearance (next-themes) and the shadcnblocks color theme (a `data-theme`
 * attribute + the generated `app/themes.css` blocks).
 *
 * The color theme is a real stylesheet change, not a class name: this asserts
 * the radius and the font family actually resolve differently, which is what a
 * user sees. Both choices must also survive a reload, and opening/switching must
 * not remount the runtime owner (the transcript marker check).
 *
 * Prereq: `npm run build -w @science-studio/transport-client`. Needs a Chromium
 * (SKIPs without one).
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

const readToken = (page, name) =>
  page.evaluate(
    (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
    name,
  );

test(
  "the theme menu switches appearance and color theme, and both persist",
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

      // The base stylesheet is the default theme: its own radius, the app font.
      assert.equal(await readToken(page, "--radius"), "0.625rem");
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        "default",
      );

      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Astrovista" }).click();

      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        "astrovista",
      );
      // Astrovista is Outfit with a 0.5rem radius — a stylesheet change the user
      // can see, not just an attribute. The colors are the registry item's own
      // literals (an independent source of truth, not recomputed here).
      assert.equal(await readToken(page, "--radius"), "0.5rem");
      assert.match(await readToken(page, "--font-app-sans"), /Outfit/);
      assert.equal(await readToken(page, "--background"), "oklch(0.9383 0.0042 236.4993)");

      // The same menu owns the light/dark switch.
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Dark" }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      // The dark block of the SAME theme applies (its own canvas, not the base one).
      assert.equal(await readToken(page, "--background"), "oklch(0.2178 0 0)");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.theme),
        "astrovista",
        "the color theme survives a reload",
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        "the dark appearance survives a reload",
      );
      assert.equal(await page.getByText(HISTORY_MARKER).count(), 1);
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
