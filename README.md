# Science Studio

> 中文: [README.zh.md](./README.zh.md)

A research-agent platform for computational life-science R&D. Researchers and
managers run and observe agent-driven work with full traceability: every agent
action lands as a reproducible, attributable research record.

Science Studio owns the **research record** — in v1, `Project` → `Session` → `Run`:
a Project owns one shared workspace and any number of Sessions, and each research
turn is a `Run` (`Study`/`Task`/`Artifact`/`Evidence`/`Conclusion` are deferred,
see CONTEXT.md). Agent runtimes are swappable adapters behind a single transport
seam. The frontend only ever speaks assistant-ui's assistant-transport protocol,
so swapping a runtime never touches the UI.

## Status

Early framework, with the core conversation loop working end to end:

- **Live assistant-ui Thread** (`apps/web`, :3000) ↔ **transport-service**
  (:3001) ↔ a runtime (**openclaw** gateway or a local **dsh** harness). SSE
  streaming with client-safe `set` / `append-text` state ops. The Thread is the
  component registered from the assistant-ui registry (Tailwind v4 + shadcn/ui).
- **History loads on page open** — the web app fires a mount-time probe and the
  service reconciles every client against its canonical transcript, so prior
  messages render on first load and after reloads.
- **Standing watch** — remote turns (e.g. from the openclaw UI) and native
  command replies (`/status`) settle into the transcript and render without a
  refresh, via a long-lived watch channel behind a guarded-import interlock.
- **Two runtimes behind one seam** (`transport-openclaw`, `transport-dsh`),
  loaded DYNAMICALLY by the service's composition root: the default module list
  is data in the service's `package.json` and `SS_RUNTIME_MODULES` overrides it,
  so adding a runtime edits no core code. A private enterprise module
  (`SS_ENTERPRISE_MODULE`) swaps in the multi-user backend.
- **Runtime slash commands** — the composer's "/" menu is built from the
  adapter's command catalog (`GET /api/transport/commands`); executing one appends
  its invocation text as an ordinary user message and is never recorded as a `Run`.
- **Project-scoped workspace Files panel** — browse/preview/download plus raw
  upload, with containment/symlink/size invariants; one workspace per Project,
  shared by all its Sessions. Opt-in: a deployment without `PROJECT_ROOT` disables
  the affordance instead of opening into a 503.
- **Project → Session → Run record** — Projects own their Sessions and share what
  they produce; each research turn is persisted as a `Run` (in a dependency-free
  JSONL store by default), rolled up per Project.

The implementation packages and both examples each have a test suite
(`npm test`); the web app adds a browser regression test guarding the runtime
re-render invariant (`npm run test:e2e -w @science-studio/web`).

## Repository layout

```
science-studio/
├── apps/
│   └── web/                          Next.js 15 frontend (assistant-ui Thread + Files panel, :3000)
├── packages/
│   ├── record/                       record seam: Project/Session/Run + RecordStore (memory & JSONL)
│   ├── transport/                    SEAM package, two entries: ./seams (contract) + . (kit + defaults)
│   ├── workspace/                    Workspace implementations (FsWorkspace + invariants)
│   ├── contract-tests/               shared seam conformance suites every implementation runs
│   ├── transport-client/             assistant-ui client boundary (useTransport, workspace, catalog)
│   ├── transport-openclaw/           openclaw runtime adapter (+ its own launch surface)
│   └── transport-dsh/                dsh runtime adapter (local harness child)
├── services/
│   └── transport-service/            backend assistant-transport service (Fastify, :3001)
├── examples/                         minimal apps over each adapter (Vite, dev-only)
├── scripts/                          dev smoke tools
├── docs/                             architecture + ADRs + design specs (EN/ZH)
├── CONTEXT.md                        domain glossary (authoritative vocabulary)
└── AGENTS.md                         repo & wire-contract operational notes
```

## Commands

```bash
npm install            # install all workspaces
npm run build          # build record → transport → workspace → contract-tests → transport-client
                       #   → transport-openclaw → transport-dsh → transport-service (the real type gate)
npm run dev            # transport-service (:3001) + web (:3000) together
npm run dev:dsh        # the same pair, with the service forced onto the dsh runtime
npm run dev:service    # transport-service only
npm run dev:web        # web only
npm test               # every workspace's suite
npm run test:e2e -w @science-studio/web   # browser regression (Chromium auto-detected; skips without one)
npm run smoke:adapter  # drive one chat.send against a live openclaw gateway (needs build + .env)
npm run smoke:dsh      # drive the dsh harness (needs build + the route's credential in
                       #   examples/transport-dsh-example/.env; export DSH_PROVIDER/DSH_MODEL
                       #   to drive a non-default route)
npm run smoke:replay -- <frames-file>     # fold captured SSE frames through the client decoder
npm run dev:desktop                        # Electron against the running dev pair
npm run pack -w @science-studio/desktop    # dmg / AppImage+deb / per-user x64 NSIS (build on the target OS)
```

> `npm run typecheck` is **known-broken** in transport-service (pre-existing
> TS6310: composite refs + `--noEmit`); other workspaces pass. Use `npm run
> build` for the service.

## Getting started

```bash
npm install
npm run build
npm run dev
```

Open http://localhost:3000. The web app streams from `/api/transport`, served by
a streaming Route Handler that pipes the transport-service body through
(`app/api/transport/route.ts`) so the UI stays same-origin and SSE token streams
survive. Runtime-specific setup:

- **openclaw**: a reachable gateway, configured via
  `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` in
  `services/transport-service/.env` (see its `.env.example`), plus a working LLM
  provider — the configured provider must be up or runs stall at `starting_model`.
- **dsh**: a local harness child (`dsh --profile sdk`, spawned by the adapter),
  selected with `TRANSPORT_RUNTIME=dsh` in `services/transport-service/.env`. Its
  LAUNCH environment — `DSH_PROVIDER`/`DSH_MODEL` (the harness route),
  `DSH_WORKSPACE` (the agent's working directory), `DSH_HOME`, `DSH_PROFILE`,
  `DSH_DEFAULT_SESSION`, `DSH_TRANSCRIPT_DIR` — can NOT be spelled in that
  `.env`: the harness child reads `.env` from the launcher's cwd as its project
  layer and hard-refuses any `DSH_*` key. The service's `dev` script exports them
  instead (defaults: route `ollama-local`/`qwen3.8:latest`, workspace
  `$HOME/workspace/dsh-workspace`, session `science-studio`; an exported `DSH_*`
  wins), so every dev launch — root `npm run dev` included — lands on the
  intended route, while `npm run dev:dsh` only adds the runtime selector.
  Leaving them unset falls back to `deepseek-official`/`deepseek-v4-flash` with
  the agent's cwd at the launcher's cwd (this package's source directory). The route itself — endpoint, models, credential name — is harness-side
  in `~/.dsh/settings.yaml`, and that route's `apiKeyEnv` name must be set to a
  non-empty value in the `.env` (e.g. `OLLAMA_LOCAL_API_KEY`); unlike `DSH_*`, a
  credential line there is legal and inherited by the child. See
  `examples/transport-dsh-example` for the full env surface.

Workspace file access is opt-in: set `PROJECT_ROOT` (the host-side parent of every
project directory; plus optional `PROJECT_AGENT_ROOT`, `WORKSPACE_MAX_INLINE_BYTES`,
`WORKSPACE_MAX_UPLOAD_BYTES`, `WORKSPACE_QUOTA_BYTES`) to expose the Files panel.
Each Project's workspace is `<PROJECT_ROOT>/<projectId>/`, shared by all its
Sessions.

The record layer is persistent by default: the service writes
`$XDG_DATA_HOME/science-studio/record.jsonl` (override with `RECORD_STORE_PATH`;
`RECORD_STORE=memory` opts out).

Verify the service without the browser:

```bash
curl -sN -X POST http://localhost:3001/api/transport \
  -H 'content-type: application/json' \
  -d '{"commands":[],"state":{"status":"idle","messages":{}},"threadId":null}'
```

A session with history streams a full state snapshot (one `set` on `messages`)
and must terminate with `data: [DONE]`.

## Documentation

- `CONTEXT.md` — the authoritative domain glossary.
- `AGENTS.md` — repo layout, commands, the transport wire contract and the
  architecture rules (the operational companion to this README).
- `docs/architecture.md` — the system architecture.
- `docs/adr/` — hard-to-reverse decisions (0001 backend transport, 0002 record
  ownership, 0003 runtime commands, 0004 dsh harness).
- `docs/design/` — the research-agent framework and implementation plan (EN/ZH).

## Domain vocabulary

See `CONTEXT.md` (`Project`, `Project Workspace`, `Session`, `Run`, `Runtime
Command`, `Command Catalog`, `Workflow`; `Study`/`Task`/`Artifact`/`Evidence`/
`Conclusion`/`AgentBlueprint` are listed there as deferred).
