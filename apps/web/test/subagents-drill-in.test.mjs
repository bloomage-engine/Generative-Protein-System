import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MARKER,
  findChromium, freePort, killTree, newWorkbenchPage,
  mockRecordSurface, mockWorkbenchSurfaces, startWebServer, waitForServer, warmWorkbench,
} from "./harness.mjs";

const H = 3600e3;
// The row must be RECENT (within 24h of REAL now) to be visible in the DEFAULT
// view — relative to Date.now() so it never ages out like a fixed date would.
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ROWS = [
  {
    id: "child-1",
    parentId: "s1",
    label: "Deep dive",
    provider: "fork",
    status: "completed",
    stopReason: "max-tokens",
    startedAt: iso(2 * H),
    finishedAt: iso(1 * H),
  },
];

test("the drill-in shows a Details block (with stopReason) and a Result section", { timeout: 240_000 }, async (t) => {
  const executablePath = findChromium();
  if (!executablePath) { t.skip("no Chromium found"); return; }
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
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: {}, plugins: {}, agent: {}, subagents: { visibleWindowHours: 24 }, runtime: "dsh", settingsPath: "/tmp/s.json" }),
      }),
    );
    await page.route("**/api/transport/subagents*", (route) =>
      route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ subagents: ROWS }) }),
    );
    await page.route("**/api/transport/subagents/child-1/transcript*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: {
            id: "child-1",
            parentId: "s1",
            provider: "fork",
            agentProvider: "ollama-local",
            agentModel: "qwen3.8",
            startedAt: iso(2 * H),
            finishedAt: iso(1 * H),
            status: "completed",
            stopReason: "max-tokens",
            messages: [
              { id: "m1", role: "user", parts: [{ type: "text", text: "Go look at the paper." }] },
              { id: "m2", role: "assistant", parts: [{ type: "text", text: "The paper concludes X." }] },
            ],
          },
        }),
      }),
    );

    await page.goto(`http://localhost:${port}/projects/p1/sessions/s1`, { waitUntil: "domcontentloaded" });
    await page.getByText(HISTORY_MARKER).waitFor({ timeout: 30_000 });
    const subagents = page.locator('[data-section="subagents"]');
    await subagents.waitFor({ timeout: 15_000 });
    await subagents.getByRole("button", { name: "Subagents" }).click();
    await subagents.getByText("Deep dive").waitFor({ timeout: 10_000 });
    await subagents.getByText("Deep dive").dblclick();

    // The drill-in tab renders in the CENTER panel (FilePreviewPane) — scope
    // here, because the Subagents panel row ALSO shows the provider and the
    // stopReason, so page-wide locators would resolve twice (strict mode).
    const tab = page.getByTestId("center");
    // The Details block:
    await tab.getByText("fork", { exact: true }).waitFor({ timeout: 10_000 });
    await tab.getByText("completed", { exact: true }).waitFor({ timeout: 10_000 });
    await tab.getByText("max-tokens").waitFor({ timeout: 10_000 });  // stopReason surfaced
    // The Result section (the assistant message's text is ALSO in the
    // transcript below it, so assert inside the Result section itself):
    const result = tab.locator("section").filter({ hasText: "Result" });
    await result.getByText("Result", { exact: true }).waitFor({ timeout: 10_000 });
    await result.getByText("The paper concludes X.").waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\n--- web log ---\n${server.log().slice(-2000)}`);
  } finally {
    await browser?.close();
    killTree(server.child, port);
  }
});
