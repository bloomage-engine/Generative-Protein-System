/**
 * Regression: toggling the Files panel must not wipe the chat history.
 *
 * `useTransport` must be called by a component that never re-renders: the
 * assistant-ui transport runtime rebuilds its internal thread-list adapter on
 * every invocation, so a re-render of the owning component reads as an adapter
 * swap — it tears the active thread down and starts an empty one, wiping the
 * transcript, and the mount-time history probe does not re-run, so the
 * conversation stays blank until a reload. `apps/web/app/page.tsx` therefore
 * keeps state out of the runtime-owning `Session` (memoized, state-free) and in
 * `WorkspaceShell` below it. If that structure regresses, clicking Files blanks
 * the thread — this test goes red.
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
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const HISTORY_MARKER = "history-marker-42";

/** The canonical transcript the mocked probe always reconciles a fresh client to. */
const SNAPSHOT_FRAMES =
  'data: {"type":"update-state","path":[],"operations":[' +
  '{"type":"set","path":["status"],"value":"idle"},' +
  `{"type":"set","path":["messages","u1"],"value":{"id":"u1","role":"user","parts":[{"type":"text","text":"${HISTORY_MARKER}"}]}},` +
  '{"type":"set","path":["messages","a1"],"value":{"id":"a1","role":"assistant","parts":[{"type":"text","text":"assistant-reply"}]}}' +
  "]}\n\n" +
  "data: [DONE]\n\n";

function findChromium() {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const caches = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ];
  const layouts = [
    ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
    ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    ["chrome-mac", "Chromium.app/Contents/MacOS/Chromium"],
    ["chrome-mac", "headless_shell"],
    ["chrome-mac-arm64", "Chromium.app/Contents/MacOS/Chromium"],
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
  ];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache)) {
      for (const layout of layouts) {
        const candidate = join(cache, dir, ...layout);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(systemChrome) ? systemChrome : null;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server at ${url} never came up`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function startWebServer(port) {
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));
  return { child, log: () => log };
}

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

test(
  "clicking the Files panel keeps the chat history",
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
      const page = await browser.newPage();

      // The transport probe reconciles to the full transcript. The route now
      // carries the Project/Session scope in its query, so the glob must allow it.
      await page.route("**/api/transport*", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: SNAPSHOT_FRAMES,
        });
      });
      // The standing watch stays quiet: only the mount probe may (re)populate
      // history, so a reset is not masked by a watch baseline.
      await page.route("**/api/transport/watch", (route) =>
        route.fulfill({ status: 404, body: "" }),
      );
      await page.route("**/api/transport/commands", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"commands":[]}',
        }),
      );
      // A workspace exists, so the Files toggle is enabled and the panel opens.
      await page.route("**/api/workspace/entries*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "",
            entries: [{ path: "notes.txt", name: "notes.txt", kind: "file", size: 3 }],
          }),
        }),
      );
      await page.route("**/api/workspace/file*", (route) =>
        route.fulfill({ status: 200, headers: { "content-type": "text/plain" }, body: "hi" }),
      );

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

      await page.getByRole("button", { name: "Files" }).click();
      await page.waitForTimeout(1_500);

      assert.equal(
        await page.getByText(HISTORY_MARKER).count(),
        1,
        "the user message must survive the Files click",
      );
      assert.equal(
        await page.getByText("assistant-reply").count(),
        1,
        "the assistant reply must survive the Files click",
      );
    } catch (error) {
      throw new Error(`${error.message}\n--- web server log ---\n${server.log().slice(-2000)}`);
    } finally {
      await browser?.close();
      killTree(server.child);
    }
  },
);
