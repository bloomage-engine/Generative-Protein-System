# The desktop app is Electron with embedded Next and transport servers

Science Studio ships a **Desktop App**: a distributable Electron package for the
single-user product. Electron's main process owns only the window and lifecycle;
a single forked Node child hosts BOTH servers the product already has — the
Next.js frontend (built `output: "standalone"`) and the Fastify
transport-service — on loopback ephemeral ports it reports back over IPC. The
app bundles no model and no runtime CLI: it runs the **dsh** runtime against a
model route the Researcher configures in an in-app Settings page.

- **Status**: accepted
- **Context**: the product is two Node processes wired by streaming HTTP — the
  Next app on 3000 relays every `/api` hop (SSE, watch NDJSON, workspace
  streams) to the transport-service on 3001 (`apps/web/app/api/*`,
  `apps/web/lib/service-proxy.ts`) — and its file/record state lives in env-var
  roots (`PROJECT_ROOT`, `RECORD_STORE_PATH`, `DSH_*`). "Package it as a desktop
  app" therefore cannot mean a thin window over `localhost:3000`: a distributable
  app must start the servers itself, on ports that cannot collide with a
  developer's dev pair, from data directories it owns. The frontend cannot be
  statically exported in place: all five `/api` routes are `force-dynamic` Node
  streaming proxies, and moving those hops into the renderer would break the one
  rule that makes every hop forward auth and relay status verbatim. The default
  runtime is `openclaw` (an external gateway) but `dsh` spawns a LOCAL harness
  child whose cwd is the Project Workspace (docs/adr/0008), which is the only
  shape a self-contained desktop app can offer without reaching the network for
  a gateway.
  *Considered and rejected*: (1) a dev launcher that just loads
  `localhost:3000` — not a desktop app and it assumes a running `npm run dev`;
  (2) static-exporting the frontend so the renderer calls the service directly —
  a real refactor, drops the auth-forwarding relay and the CORS-free same-origin
  story, and trades a known-good streaming path for a new one; (3) embedding the
  Fastify service in the Electron main process — mixes server ESM with Electron's
  main-process lifecycle, so a service crash takes the window with it and there
  is no clean restart point.
- **Decisions**:
  - **One forked child hosts both servers.** Electron main `fork`s a small
    entrypoint that starts the transport-service (`createTransportService`) and
    the Next standalone server; the two keep talking over loopback exactly as in
    dev, so no transport or proxy code changes. Main kills the child on quit,
    reaps it on restart, owns the window, and logs an unexpected child exit — it
    does NOT auto-restart; the menu's "Restart Service" is the recovery. Two
    single-purpose children were rejected as more lifecycle for no isolation we
    need.
  - **Loopback ephemeral ports, never 3000/3001.** Both servers bind `127.0.0.1`
    port `0`; the child reports the assigned ports to main over IPC and the
    window loads the reported Next URL. A developer's own `npm run dev` pair can
    run alongside the app.
  - **The frontend stays a Next server.** `next build` runs at PACKAGE time with
    `output: "standalone"`; the standalone `.next/static` + `server.js` ship as
    Electron `extraResources`. This preserves the streaming `/api` proxies, the
    query-first Project/Session scope, and the one-relay policy untouched.
  - **dsh is the desktop runtime, with a user-configured route.** No model
    weights and no `dsh` binary are bundled. A Settings page writes the route
    (provider, model, baseURL, credential) to `<userData>/config.env`, which the
    child reads and re-exports as the launch-only `DSH_*` names (the harness
    child hard-refuses those keys in a project `.env`, so they must come from the
    launcher env). `openclaw` remains configurable, not defaulted.
  - **Detect `dsh`, degrade friendly.** At startup the app probes `dsh` on PATH;
    when it is missing or the route is unreachable, the workbench shows a setup
    screen and disables sending rather than failing a run.
  - **Data directories are the app's, with Projects user-visible.** Project Root
    defaults to `~/Documents/Science Studio/projects/<projectId>/` so research
    files are findable and backable-up; app-internal state (the JSONL record
    store, dsh home, transcript mirror, `config.env`) lives under Electron
    `userData`.
  - **Single-user only.** The Desktop App never loads `SS_ENTERPRISE_MODULE`
    (docs/adr/0002's hosted mode stays a server deployment).
  - **v1 shell is minimal.** One window, the default menu, and "Open project in
    file manager"; no tray. Auto-update and code signing are deferred, so v1
    packages are unsigned (macOS first launch needs a right-click open).
  - **It lives in `apps/desktop`, outside the root build gate at first.**
    Electron brings its own type/toolchain weight; the app gets a dedicated
    `build:desktop` script and joins the root `npm run build` gate only once it
    is stable. `electron-builder` produces `.dmg` (macOS) and `.AppImage`/`.deb`
    (Linux) first, with Windows config kept but unshipped.
  - **Identity**: product name `Science Studio`, bundle id `ss.hx-engine.com`.
  - **Considered and rejected**: Electron Forge (viable, but more plugin wiring
    for the monorepo's `extraResources` needs) and electron-vite (a dev/build
    tool, complementary to a packager, not a replacement).
- **Consequences**: the repo grows a fifth workspace stack (Electron main,
  preload, a build script, `electron-builder` config) that is deliberately not in
  the shared type gate yet, so nothing in the existing packages is disturbed. The
  desktop transcript and record live per-machine under `userData`; moving a
  Project between machines means moving its `~/Documents/Science Studio/projects`
  folder, not the app state. Because the child re-exports the route as `DSH_*`,
  the harness's own project-layer refusal never sees those keys, and the app
  keeps working when the Researcher's model endpoint changes — at the cost of a
  settings surface to maintain. An unsigned v1 is fine for local use and a known
  blocker for public distribution; when a release channel appears, signing and
  `electron-updater` become a follow-up decision, not a rewrite.
