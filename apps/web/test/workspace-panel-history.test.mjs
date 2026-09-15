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

/**
 * The HTTP surfaces the workbench needs, mocked entirely in the browser (so no
 * transport-service, runtime adapter or workspace deployment is required).
 *
 * The transport probe reconciles every client to the full transcript; the
 * standing watch stays quiet (only the mount probe may (re)populate history, so
 * a reset is not masked by a watch baseline); and a workspace exists, so the
 * Files toggle is enabled and the panel opens.
 */
async function mockWorkbenchSurfaces(page) {
  await page.route("**/api/transport*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: SNAPSHOT_FRAMES,
    });
  });
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
}

/**
 * The record surface (`/api/projects*`) the Projects pane reads — the only
 * place a Project/Session is created now, so the POSTs mint "Gamma" and its
 * first Session.
 *
 * Two patterns, because a Playwright glob's `*`/`**` never crosses `/`: the
 * bare list (`/api/projects`) and a Project's Sessions
 * (`/api/projects/<id>/sessions`) each need their own.
 */
async function mockRecordSurface(page) {
  const handle = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/projects/, "");

    if (request.method() === "POST") {
      return path === ""
        ? route.fulfill({ json: { project: { id: "p3", name: request.postDataJSON().name } } })
        : route.fulfill({ json: { session: { id: "s-new", projectId: "p3", title: "Fresh session" } } });
    }
    if (path === "" || path === "/") {
      return route.fulfill({
        json: {
          projects: [
            { id: "p1", name: "Alpha" },
            { id: "p2", name: "Beta" },
          ],
        },
      });
    }
    if (path === "/p1/sessions") {
      return route.fulfill({ json: { sessions: [{ id: "s1", title: "First session" }] } });
    }
    if (path === "/p2/sessions") {
      return route.fulfill({ json: { sessions: [{ id: "s9", title: "Beta session" }] } });
    }
    return route.fulfill({ status: 404, body: "" });
  };

  await page.route("**/api/projects", handle);
  await page.route("**/api/projects/**", handle);
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
      await mockWorkbenchSurfaces(page);

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
      const page = await browser.newPage();

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
      killTree(server.child);
    }
  },
);
