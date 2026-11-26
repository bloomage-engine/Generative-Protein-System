/**
 * The settings dialog: the status-bar gear opens it, the left tab list switches
 * panels, and Save persists through `/api/settings`. Opening the dialog must not
 * remount the runtime owner (it lives in the StatusBar, not in `SessionView`),
 * which the transcript marker check covers.
 *
 * Prereq: `npm run build -w @gps/transport-client`. Needs a Chromium
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

const VIEW = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

test(
  "the gear opens the settings dialog and Save persists",
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
      const puts = [];
      await page.route("**/api/settings", async (route) => {
        const request = route.request();
        if (request.method() === "PUT") puts.push(request.postDataJSON());
        return route.fulfill({ json: VIEW });
      });

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Plugins" }).click();
      await page.getByText("Plugin configuration is coming soon.").waitFor({ timeout: 5_000 });
      await page.getByRole("tab", { name: "Model" }).click();

      await page.getByLabel("Provider").fill("from-ui");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText(/Saved — restart the service/).waitFor({ timeout: 10_000 });

      assert.equal(puts.length, 1);
      assert.equal(puts[0].model.provider, "from-ui");
      assert.ok(!("apiKey" in puts[0].model), "an untouched key is not sent");

      await page.getByRole("button", { name: "Close" }).click();
      assert.equal(await page.getByText(HISTORY_MARKER).count(), 1, "the transcript survived the dialog");
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
