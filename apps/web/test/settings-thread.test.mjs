/**
 * The Thread settings tab: visible message count input and reset button.
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

const VIEW = {
  model: { provider: "ollama-local", model: "qwen3.8:latest", endpoint: "http://h/v1", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  subagents: {},
  thread: { visibleMessageCount: 20 },
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

test(
  "the Thread tab renders with visible message count input and reset button",
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
      await page.route("**/api/settings", (route) =>
        route.fulfill({ json: VIEW }),
      );

      await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });

      // Open settings dialog
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });

      // Click Thread tab
      await page.getByRole("tab", { name: "Thread" }).click();

      // Verify visible message count input exists
      const input = page.getByLabel(/visible messages/i);
      await input.waitFor({ timeout: 5_000 });
      const value = await input.inputValue();
      assert.equal(value, "20", "visible message count shows the current value");

      // Verify reset button exists
      await page.getByRole("button", { name: /reset/i }).waitFor({ timeout: 5_000 });
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);

test(
  "the Thread tab Save persists thread.visibleMessageCount",
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

      // Open settings dialog
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10_000 });

      // Click Thread tab
      await page.getByRole("tab", { name: "Thread" }).click();

      // Change the value
      await page.getByLabel(/visible messages/i).fill("50");
      await page.getByRole("button", { name: "Save" }).click();

      // Wait for save
      await page.getByText("Saved.").waitFor({ timeout: 10_000 });

      // Verify the PUT included thread.visibleMessageCount
      assert.equal(puts.length, 1);
      assert.equal(puts[0].thread?.visibleMessageCount, 50);
    } finally {
      if (browser) await browser.close();
      killTree(server.child, port);
    }
  },
);
