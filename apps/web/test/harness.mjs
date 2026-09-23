/**
 * The shared browser harness for the `apps/web` regression tests: Chromium
 * discovery, a dev server, and the mocked HTTP surfaces the workbench needs.
 *
 * Every test here drives the REAL app in a real browser; only the service is
 * mocked (transport + record + workspace), so nothing needs a gateway, an
 * adapter or a workspace deployment.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
export const HISTORY_MARKER = "history-marker-42";

/** The canonical transcript the mocked probe always reconciles a fresh client to. */
export const SNAPSHOT_FRAMES =
  'data: {"type":"update-state","path":[],"operations":[' +
  '{"type":"set","path":["status"],"value":"idle"},' +
  `{"type":"set","path":["messages","u1"],"value":{"id":"u1","role":"user","parts":[{"type":"text","text":"${HISTORY_MARKER}"}]}},` +
  '{"type":"set","path":["messages","a1"],"value":{"id":"a1","role":"assistant","parts":[{"type":"text","text":"assistant-reply"}]}}' +
  "]}\n\n" +
  "data: [DONE]\n\n";

export function findChromium() {
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

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitForServer(url, timeoutMs) {
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

export function startWebServer(port, env = {}) {
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    // A private build dir: the developer's own `npm run dev` shares `.next`
    // otherwise, and two dev servers on one build dir corrupt it (missing
    // chunks, 500s, "Fast Refresh had to perform a full reload").
    // `env` lets a test point the proxies at its own upstream (`startWatchStub`).
    env: { ...process.env, NEXT_DIST_DIR: ".next-test", ...env },
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));
  return { child, log: () => log };
}

/**
 * A stub of the transport-service's long-lived endpoints, over a REAL socket.
 *
 * The standing watch is an NDJSON stream that by design never ends, so every
 * mount of the runtime occupies one browser connection until something aborts
 * it. Playwright's `route.fulfill` cannot express "never ends" (and an
 * in-browser mock would occupy no socket at all), so the socket-exhaustion
 * regression needs a real server: the test points the web server's
 * `TRANSPORT_SERVICE_URL` here and leaves `/api/transport/watch` unmocked.
 */
export async function startWatchStub() {
  let open = 0;
  const sockets = new Set();
  const server = createHttpServer((req, res) => {
    if (req.url.startsWith("/api/transport/watch")) {
      open += 1;
      // Headers only: the connection is established and then stays silent (the
      // real watch likewise pushes nothing until a run settles). Pushing a
      // placeholder snapshot here would overwrite the transcript the mount probe
      // imported, which is not what this stub is for.
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      res.on("close", () => {
        open -= 1;
      });
      return; // never ends — the client has to abort
    }
    if (req.url.startsWith("/api/transport/commands")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"commands":[]}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    openWatches: () => open,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A finished test's cleanup must not be able to wedge: `http.Server.close()`
 * waits for every open socket to drain (an abandoned keep-alive or a
 * pooled-socket browser never does), and `browser.close()` can wait on an
 * unresponsive Chromium — either one then hangs the process, and the whole
 * `--test` runner behind it (observed: a stuck child sat 20+ min holding its
 * dev server and browser). At cleanup time the test is OVER and whatever is
 * still streaming was aimed at nobody, so race the close against a short
 * deadline. The timer is unref'd, so on the normal path it never keeps the
 * process alive on its own.
 */
export function closeWithDeadline(close, ms) {
  const timer = new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
  return Promise.race([Promise.resolve(close).catch(() => {}), timer]);
}

export function killTree(child, port) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  if (port === undefined) return;
  // `next dev` runs a separate `next-server` process that can outlive the group
  // kill (one leaked per full suite run before this), so reap whatever still
  // holds the port. Scoped to this test's own port — never the developer's dev
  // server on 3000.
  try {
    execFileSync("sh", [
      "-c",
      `pkill -f "dev -p ${port}" >/dev/null 2>&1; for pid in $(lsof -ti tcp:${port} 2>/dev/null); do kill -9 $pid; done`,
    ]);
  } catch {
    /* nothing left to reap */
  }
}

/**
 * The page a test drives. A cold `next dev` compiles a route on its FIRST
 * request — over a minute for the workbench on a fresh build dir — so the
 * browser's default 30 s navigation timeout is not enough for the first visit.
 */
export async function newWorkbenchPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(180_000);
  return page;
}

/**
 * Compile the routes a test is about to visit, in Node instead of in a browser
 * navigation. One `next dev` compiles a route PATTERN once, so one instance of
 * the session deep-link covers every scope a test drives.
 *
 * `transport: true` warms the `/api/transport/*` proxies as well — only a test
 * whose web server has a real upstream (`startWatchStub`) can, and only a
 * connection-pool test needs to: a cold compile there (seconds) holds a
 * connection while the page is trying to use them, which such a test must not
 * mistake for a leak. The watch never ends, so its warm-up is aborted as soon as
 * the headers arrive.
 */
export async function warmWorkbench(base, opts = {}) {
  // The worktree deep-link is its OWN route pattern, so the legacy two-part
  // Session link does not compile it (docs/adr/0025).
  for (const path of ["/", "/projects/p1/sessions/s1", "/projects/p1/worktrees/exp-a/sessions/s-exp"]) {
    const response = await fetch(`${base}${path}`);
    await response.text();
    if (!response.ok) throw new Error(`warming ${path} failed: ${response.status}`);
  }
  if (!opts.transport) return;

  const commands = await fetch(`${base}/api/transport/commands`);
  await commands.text();
  if (!commands.ok) throw new Error(`warming the command catalog failed: ${commands.status}`);

  // A quiet watch sends no body, and the proxy only flushes its response head
  // with the first chunk — so this request may never even see a status. It is
  // here to trigger the route's compile, so it is aborted on a timer and its
  // outcome ignored.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`${base}/api/transport/watch?projectId=p1&threadId=s1`, {
      signal: controller.signal,
    });
  } catch {
    /* compile trigger only */
  } finally {
    clearTimeout(timer);
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
 *
 * Returns the transport POSTs seen, in order: their URLs carry the scope the
 * client actually asked with, which is how the scope tests assert that a load
 * resolved before it probed (docs/adr/0009).
 */
export async function mockWorkbenchSurfaces(page, opts = {}) {
  const { watch = true, commands = true } = opts;
  const transportPosts = [];
  await page.route("**/api/transport*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    transportPosts.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: SNAPSHOT_FRAMES,
    });
  });
  // Registered after the catch-all (Playwright tries the most recent route
  // first), and globbed with a trailing `*`: the app calls these WITH a query
  // string, which a pattern ending in the bare path does not match — the request
  // would then reach the real service through the Next proxy.
  //
  // `watch`/`commands` can be left UNMOCKED (the catch-all continues them) when a
  // test needs them to be real requests over a real socket — an in-browser mock
  // occupies no connection, so socket behaviour cannot be observed through it.
  if (watch) {
    await page.route("**/api/transport/watch*", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
  }
  if (commands) {
    await page.route("**/api/transport/commands*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"commands":[]}',
      }),
    );
  }
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
  // The HPC surface (docs/adr/0024): the Jobs section polls the ledger, and
  // the Settings tab reads endpoints/binding. An empty ledger is the honest
  // "no cluster configured / no jobs" shape.
  await page.route("**/api/hpc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/hpc/, "");
    const json = (body) =>
      route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body });
    if (path.startsWith("/jobs")) return json('{"jobs":[]}');
    if (path.startsWith("/binding")) return json('{"bound":false}');
    return json('{"endpoints":[]}');
  });
  return { transportPosts };
}

/**
 * The Worktree surface (`/api/worktrees*`) the Projects pane and the boot scope
 * resolve against (docs/adr/0025). `main` is always listed for a Project (the
 * Project root is its main worktree); `p1` also carries an `exp-a` checkout, so
 * the scope tests can switch to a non-default worktree.
 *
 * Returns the mutable `byProject` map and the request log. Mutating `byProject`
 * simulates the record changing between loads (e.g. dropping `exp-a` to prove a
 * remembered worktree falls back to `main`); the log lets a test assert a
 * fabricated id was never asked for.
 */
export const DEFAULT_WORKTREES = {
  p1: [
    { id: "main", projectId: "p1", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "exp-a", projectId: "p1", name: "Experimental", branch: "exp-a", createdAt: "2026-01-02T00:00:00.000Z" },
  ],
  p2: [{ id: "main", projectId: "p2", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" }],
  p3: [{ id: "main", projectId: "p3", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" }],
};

export async function mockWorktreeSurface(page, opts = {}) {
  const byProject = {};
  for (const [projectId, list] of Object.entries(opts.worktrees ?? DEFAULT_WORKTREES)) {
    byProject[projectId] = list.map((worktree) => ({ ...worktree }));
  }
  const requests = [];
  await page.route("**/api/worktrees*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${url.pathname}${url.search}`);
    const projectId = url.searchParams.get("projectId");
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      return route.fulfill({
        json: {
          worktree: {
            id: "exp-new",
            projectId,
            name: body.name,
            branch: body.branch ?? body.name,
            createdAt: "2026-01-03T00:00:00.000Z",
          },
        },
      });
    }
    const list = projectId ? byProject[projectId] : undefined;
    if (!list) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ json: { worktrees: list } });
  });
  return { byProject, requests };
}

/**
 * The record surface (`/api/projects*` and `/api/worktrees*`) the Projects pane
 * reads — the only place a Project/Session/Worktree is created now, so the POSTs
 * mint "Gamma" and its first Session.
 *
 * Two patterns, because a Playwright glob's `*`/`**` never crosses `/`: the
 * bare list (`/api/projects`) and a Project's Sessions
 * (`/api/projects/<id>/sessions`) each need their own. A Project's Sessions are
 * filtered by the `worktreeId` query (docs/adr/0025): `main` and `exp-a` hold
 * DIFFERENT Sessions, so a test can tell a worktree switch from a Session
 * switch. The Worktree surface rides along with a default list; a test that
 * needs to control it keeps the returned `worktrees` handle.
 */
export async function mockRecordSurface(page, opts = {}) {
  const worktrees = await mockWorktreeSurface(page, opts);

  const handle = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/projects/, "");
    const worktreeId = url.searchParams.get("worktreeId") ?? "main";

    if (request.method() === "POST") {
      return path === ""
        ? route.fulfill({ json: { project: { id: "p3", name: request.postDataJSON().name } } })
        : route.fulfill({
            json: { session: { id: "s-new", projectId: "p3", worktreeId, title: "Fresh session" } },
          });
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
      const sessions =
        worktreeId === "exp-a"
          ? [
              { id: "s-exp", projectId: "p1", worktreeId: "exp-a", title: "Experiment session" },
              { id: "s-exp-2", projectId: "p1", worktreeId: "exp-a", title: "Experiment two" },
            ]
          : [{ id: "s1", projectId: "p1", worktreeId: "main", title: "First session" }];
      return route.fulfill({ json: { sessions } });
    }
    if (path === "/p2/sessions") {
      return route.fulfill({
        json: { sessions: [{ id: "s9", projectId: "p2", worktreeId: "main", title: "Beta session" }] },
      });
    }
    // The project the POST above mints is fresh: its Session list is EMPTY, not
    // a 404 (a created Project exists, it just has no Sessions yet). The create
    // flow expands it immediately, which lists it — so this must answer the way
    // the real record surface does.
    if (path === "/p3/sessions") {
      return route.fulfill({ json: { sessions: [] } });
    }
    return route.fulfill({ status: 404, body: "" });
  };

  await page.route("**/api/projects", handle);
  await page.route("**/api/projects/**", handle);
  return { worktrees };
}
