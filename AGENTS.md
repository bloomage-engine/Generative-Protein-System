# AGENTS.md

npm-workspaces TypeScript monorepo. Artifacts (commit messages, README, docs,
ADRs, AGENTS.md, design specs) are written in English; conversation happens in
Chinese.

## Structure

```
apps/web                          Next.js frontend (assistant-ui Thread UI, port 3000)
  app/page.tsx                      the SPA home — resolves the Project/Session scope (URL claim, else the remembered one, validated against the record), then renders the workbench
  app/projects/[projectId]/sessions/[sessionId]/page.tsx  the same workbench, scoped by the route
  app/api/{transport,workspace,projects}  proxies to the service — every hop relays through ONE policy module (lib/service-proxy.ts: base URL, forwarded auth, verbatim status/body) which never uses next.config rewrites (they buffer) nor `fetch` (its 300 s body deadline kills an idle stream; the relay is lib/stream-proxy.ts)
  components/studio                 the workbench shell: top bar (its two switch buttons give the LEFT slot to the conversation or the Projects pane), Projects pane (create Project + Session over `/api/projects*`; a click EXPANDS a Project for browsing, a DOUBLE click on a Session opens it — expanding must not move the scope, so the conversation and the file tree stay put), file tree/preview panes, tab strip, status bar
  store/studio-store.ts             the shell's scope + chrome state (projects list, active Project/Session, left view + panel visibility, open tabs)
  components/session-view.tsx       providers + the memoized runtime owner; with no scope it renders the chrome alone
  components/assistant-ui/elements  Thread UI registered from the assistant-ui registry
  components/workspace              workspace browser/viewer panel
  components/ui + hooks + lib       shadcn/ui base, registry helpers
  (Tailwind v4 + shadcn/ui styling stack: postcss.config.mjs, components.json)
packages/record                   RECORD SEAM PACKAGE: v1 vocabulary is Project/Session/Run only (Study/Task/Artifact/Evidence/Conclusion/AgentBlueprint deferred — docs/adr/0007) + the RecordStore contract + implementations (in-memory for tests; dependency-free JSONL used by default via RECORD_STORE_PATH). transport depends on it for Id/Run/RunStatus
packages/transport                SEAM PACKAGE, two entries. `./seams` = the contract only: every RUNTIME seam interface (RuntimeAdapter/StateDelta, RuntimeBinding/RuntimeFactory/RuntimePlugin/RuntimeCapabilities, Principal/PrincipalResolver, Environment/EnvironmentProvider, Workspace + limits + QuotaPolicy) plus their error classes and limit constants. `.` = that contract + the shared adapter kit (`SessionRuntime` + its `SessionBehavior` / `RunFlow` queue / `foldState` / attachment helpers / `createApplyContext`, the constructor for the transcript primitives so a behavior test drives the SAME merge rules the runtime does) + pure single-user defaults (LocalPrincipalResolver, LocalEnvironmentProvider, NullWorkspace, NoopQuotaPolicy). Exports are explicit (no `export *`); pinned by test/seams.test.ts
packages/workspace                Workspace implementations (FsWorkspace + containment/symlink/size invariants); depends on transport
packages/contract-tests          the SHARED seam conformance suites (testPrincipalResolver/testWorkspace/testRuntimeFactory/testAdapterLifecycle/testQuotaPolicy/testResolveSessionKey) every implementation runs, plus the published `sessionState()` fixture a runtime's tests drive (fixtures drift silently otherwise — no test file was type-checked); the OSS reference impls self-test here, the private module and third-party runtimes run the same suites in their CI. Imports the contract from `@science-studio/transport/seams` (never the kit)
packages/transport-client         assistant-ui client boundary (single `useTransport` session hook = history probe + standing watch + guarded import; state converter; command catalog + slash-menu / reasoning-trace helpers)
packages/transport-openclaw       openclaw runtime adapter — owns its OWN launch surface (`GatewayBinding`), factory, capabilities and `runtimePlugins`; ports gateway WS
packages/transport-dsh            dsh runtime adapter — owns `DshBinding` + factory + `runtimePlugins` (local harness child spawned by @deepseek-ai/dsh-sdk-client, pinned 0.1.5-alpha.1; stdio JSON-RPC)
services/transport-service        backend assistant-transport service — Fastify, port 3001. Composition root: `src/composition.ts`. `TRANSPORT_RUNTIME` picks the runtime product; runtime modules are loaded DYNAMICALLY by specifier, so the service statically imports NO runtime package. The DEFAULT module list is DATA — `scienceStudio.runtimeModules` in this package's own `package.json` — and `SS_RUNTIME_MODULES` overrides it entirely, so adding a runtime edits no core code. `SS_ENTERPRISE_MODULE` swaps in the private multi-user backend; unset = the complete single-user product.
examples/transport-openclaw-example  minimal assistant-ui example app over the openclaw adapter (Vite + core primitives; dev-only, not in the root build)
examples/transport-dsh-example     minimal assistant-ui example app over the dsh adapter (local harness; dev-only, not in the root build)
scripts/                          dev smoke tools (smoke-openclaw-adapter, replay-sse-frames)
docs/architecture.md              system architecture
docs/design/                      design specs (research-agent-framework EN/ZH + implementation-plan)
docs/adr/                         ADRs (0001 backend transport, 0002 record ownership, 0003 slash commands, 0004 dsh harness, 0005 shared SessionRuntime, 0006 Project is the workspace/sharing unit, 0007 v1 record layer = Project/Session/Run + file store, 0008 runtime provisioning is per Project, 0009 the workbench resumes the remembered scope)
CONTEXT.md                        domain glossary (authoritative vocabulary)
```

## Commands

- `npm install` — install all workspaces
- `npm run dev` — run service (3001) and web (3000) together via concurrently
- `npm run dev:service` / `npm run dev:web` — individually
- `npm run dev:dsh` — the same service+web pair, with the service forced onto the
  **dsh** runtime (`TRANSPORT_RUNTIME=dsh npm run dev`). The launch env is NOT in
  the `.env`: the service's own `dev` script exports the launch-only knobs
  (`DSH_PROVIDER`/`DSH_MODEL` default the LAN `ollama-local`/`qwen3.8:latest`,
  `DSH_WORKSPACE` default `$HOME/workspace/dsh-workspace`,
  `DSH_DEFAULT_SESSION` default `science-studio`; an ambient `DSH_*` wins) before
  `tsx src/index.ts`, so every dev launch — root `npm run dev` included — gets a
  working route, and `dev:dsh` only adds the runtime selector. Those names cannot
  be spelled in `.env`: the harness child reads the LAUNCHER's cwd `.env` as its
  project layer and hard-refuses any `DSH_*`/`XDG_*`/`DYLD_*` key there. Unset
  knobs are a foot-gun — the adapter falls back to
  `deepseek-official`/`deepseek-v4-flash` and the agent's cwd becomes this
  package's source directory. The route's credential NAME (`apiKeyEnv`, e.g.
  `OLLAMA_LOCAL_API_KEY`) is a legal `.env` line and is inherited by the child.
- Record layer: the v1 record is `Project` → `Session` → `Run` (docs/adr/0007).
  Project/Session/Run routes live on the same service (`/api/projects*`), and the
  store is persistent by default — `RECORD_STORE_PATH` (default
  `$XDG_DATA_HOME/science-studio/record.jsonl`) — with `RECORD_STORE=memory` to
  opt out. A `project-default` row is auto-ensured so a request that names no
  Project still works.
- Workspace file access is **opt-in** and served per **Project**: `PROJECT_ROOT`
  is the host-side parent of every project directory (each Project's workspace is
  `<PROJECT_ROOT>/<projectId>/`, shared flatly by all its Sessions — docs/adr/0006),
  `PROJECT_AGENT_ROOT` is the agent-side counterpart, and
  `WORKSPACE_MAX_INLINE_BYTES` is the inline cap; unset `PROJECT_ROOT` means
  `NullWorkspace` and no file surface. Routes live on the SAME service and ask
  `ProjectScopes` (`services/transport-service/src/project-scope.ts`) for the
  request's scope — the Principal, the Project (the query's `projectId`, else the
  query's `project` (the older spelling), else the body's, else `project-default`)
  and that Project's `Environment` — so no route spells the Project claim its own
  way and no route body repeats the preamble: `GET
  /api/workspace/{entries,stat,file}`. `file` streams inline up to the cap (413
  over it) and `?download=1` streams any size; a missing path is 404, a
  traversal/absolute path 400, no workspace 503. Uploads are `POST
  /api/workspace/upload?path=` with a **raw** body
  (`application/octet-stream`, one file per request — no multipart parser);
  `maxUploadBytes` (`WORKSPACE_MAX_UPLOAD_BYTES`, default 100 MB) answers 413 and
  `QuotaPolicy` answers 507 on the declared size. Upload caps: also
  `WORKSPACE_QUOTA_BYTES` (default 2 GB).
  The web app reaches these through `app/api/workspace/[...path]` (a streaming
  proxy, same buffering rule as the transport route). Client-side, workspace
  access is `@science-studio/transport-client`'s `useWorkspaceBrowser` /
  `useWorkspaceFile` / `resolveFileReference` / `WorkspaceOpenProvider` — the
  provider is the seam that lets an agent file link in markdown open the viewer
  instead of navigating. **The ROOT listing is shared** (`useWorkspaceRoot`): the
  file tree, the status bar's availability chip and the top-bar search all want
  that one directory, so they share one request per (api, Project) instead of
  firing three (six under dev StrictMode) that then queue behind the browser's
  ~6 connections per origin — which left the tree empty for seconds after a
  Project switch. Only deeper directories are per-hook. A 503 (no `PROJECT_ROOT`)
  is classified by
  `isWorkspaceUnavailable`, and `useWorkspaceAvailability` reads the same shared
  listing rather than probing on its own, so the UI disables its file affordance
  with friendly copy rather than opening into the
  raw 503. The composer `@` picker is `useWorkspaceMentions`; a pick
  inserts assistant-ui directive text (`:file[label]{name=id}` /
  `:directory[...]`) which the service lifts into a workspace `AttachmentRef`
  (`parseWorkspaceMentions`) — a directory stays a reference, never expanded.
- `npm run dev -w @science-studio/transport-openclaw-example` — the example app: Vite (5173, proxies `/api`) + the openclaw adapter behind `@science-studio/transport-service` (3200). Needs `examples/transport-openclaw-example/.env` (see its `.env.example`) and a live gateway, and `npm run build` first (imports deps from dist). Dev-only — intentionally NOT in the root build gate; its `npm run test` drives the same wiring against a scripted gateway (no live gateway needed).
- `npm run dev -w @science-studio/transport-dsh-example` — the same shape over the dsh adapter: Vite (5173) + `@science-studio/transport-service` (3300); the adapter spawns `dsh --profile sdk` locally (needs `examples/transport-dsh-example/.env` with `DEEPSEEK_API_KEY`, the model route `HARNESS_PROVIDER`/`HARNESS_MODEL`, and that route's `apiKeyEnv` name — `server.ts` promotes those two `HARNESS_*` names to the launch-only `DSH_PROVIDER`/`DSH_MODEL` before the adapter reads it, because the harness child runs with that folder as cwd and the dsh CLI reads that same `.env` and hard-refuses any `DSH_*` key in it; the route itself — endpoint/models — is declared harness-side in `<harness home>/settings.yaml`, and the default example route is the LAN ollama `ollama-local`/`qwen3.8:latest`; defaults when `HARNESS_*` is unset: profile `sdk`, home `~/.dsh`, workspace = the example dir, transcript mirror under the service tmp dir, adapter provider/model `deepseek-official`/`deepseek-v4-flash` — override `DSH_HOME`/`DSH_TRANSCRIPT_DIR`/`DSH_MODEL`… via exported env). Its `npm run test` drives the wiring against a scripted turn client (no dsh process needed).
- `npm run test:e2e -w @science-studio/web` — the web app's regression suite, all of it in one command: the panel/history tests mock the transport + record + workspace HTTP surface and assert the re-render invariants, `test/scope-restore.test.mjs` asserts that a load resumes the remembered scope and never probes an id the record does not list (docs/adr/0009), and `test/scope-memory.test.mjs` is the browserless resolution table (no Chromium needed; it imports `lib/scope-memory.ts` through Node's type stripping). The browser ones run their own `next dev` with a PRIVATE build dir (`NEXT_DIST_DIR=.next-test`, read by `next.config.mjs`) so the suite can run while a developer's own `npm run dev` is up — two dev servers on one `.next` corrupt it. Next rewrites `next-env.d.ts`/`tsconfig.json` to match whichever dist dir ran last, so a suite run may leave those generated lines dirty; the next `npm run dev`/`next build` flips them back. They need a Chromium (auto-detected; they SKIP without one) and `npm run build -w @science-studio/transport-client` first. Dev-only — NOT part of the root `npm test`.
- `npm run build` — build record → transport → workspace → contract-tests → transport-client → transport-openclaw → transport-dsh → transport-service, then
  `npm run typecheck:tests`; this is the real type gate. Each package's own
  `tsconfig.json` includes only `src/**` (so `tsc -b` emits just the package), so
  the TESTS are checked by one separate program, `tsconfig.tests.json` over
  `packages/*/test` + `services/*/test`. It runs LAST because
  `@science-studio/*` resolves to the built `dist` types. Outside the gate:
  `apps/web/test/*.mjs` (plain JS) and the dev-only `examples/*`.
- `npm run typecheck` — **known-broken**: fails in transport-service with pre-existing TS6310 (composite refs + `--noEmit`). Other workspaces pass; use `npm run build` for the service.
- `npm run smoke:adapter` — connect a real openclaw adapter to a live gateway and drive one `chat.send` (sends a real message to `OPENCLAW_DEFAULT_SESSION` unless `SMOKE_SESSION` overrides it). Needs `npm run build` first.
- `npm run smoke:replay -- <file>` — fold recorded SSE frames through the client decoder/accumulator (verifies a stream terminates with `[DONE]` and only uses `set` ops).
- No test suite exists anywhere yet (root `npm run test` is a no-op). — **stale**: transport, transport-openclaw, transport-client, transport-dsh, transport-service, workspace and both example workspaces have suites (root `npm run test` runs them; 113+ green as of Phase 0).

## Transport wire contract (frontend ↔ service)

- **Every transport request is Project-scoped.** The client carries `projectId`
  and the Session (as `threadId`); the service reads them from the **query string
  first, then the body**. The query wins because assistant-ui builds its own send
  body and always puts a per-page local `__LOCALID_*` threadId there — a
  body-first read would shadow the URL's Session, resolve the send to the
  adapter's default session, and reconcile the reply against a different
  transcript (the app appears to switch sessions). The body is the fallback for
  clients that scope nothing in the URL (our mount probe puts the scope in both;
  the examples put it nowhere and land on the default Project). An omitted
  `projectId` falls back to the auto-ensured `project-default`, and an unknown
  session key is first-use recorded under that Project (docs/adr/0007). Every
  route that needs a runtime or a workspace reads the claim the same way — the
  query's `projectId`, else the query's `project` (the older spelling), else the
  body's, else `project-default`; `project-scope.ts` is that rule's one home — and
  the watch additionally takes `threadId`. The command catalog follows the same
  claim, so it is the Project's own adapter's catalog.
- Frontend is assistant-ui's `useAssistantTransportRuntime`. It sends user
  messages as **`message.parts`** (array of `{type:"text",text}`), NOT
  `message.content`; `normalizeCommands` reads `msg.content ?? msg.parts`.
- SSE frame per op: `data: {"type":"update-state","path":[],"operations":[...]}`.
  The client accumulator (`assistant-stream` GorpStreamAccumulator) accepts
  **only op types `set` and `append-text`** — anything else (e.g. raw `append`)
  throws and kills the whole stream. The transport-service therefore only
  emits **`set`** and **`append-text`** ops: purely incremental adapter deltas
  (`add-part`, `append-text`) are materialized into full `parts` arrays by its
  wire fold (`WireOpsBuilder`), while token fragments (`stream-text`) become
  small `append-text` ops at the exact text path. Array paths are illegal for
  arrays; keys
  `__proto__`/`constructor`/`prototype` are rejected in segments.
- **Reconcile-first.** Every `run()` starts by yielding a `reconcile` delta
  carrying the adapter's canonical transcript. The service compares it with the
  state the client claimed in the request body (`state`) and streams a
  whole-message-map `set` when they differ (and a `status` `set` when the status
  drifted) — so a fresh page or a reload always converges to the full history.
  The adapter re-syncs its canonical transcript against gateway `chat.history`
  at the START of every `run()` (not just the first): the gateway owns the
  conversation and is not the only writer, so turns that arrived remotely
  (e.g. on the openclaw UI — including their USER rows, which never pass
  through this process) are converged by rebuilding the transcript from the
  gateway rows whenever the history is not a content-prefix (role + part
  texts) of the transcript. A gateway session reset therefore also clears the
  stale in-memory transcript, and standalone `toolResult` history rows merge
  into their assistant tool-call part instead of becoming messages. Sync
  never runs mid-run (a rebuild would wipe the partially assembled assistant
  message), and a lagging gateway keeps the local tail — an empty or
  shorter-matching history is not a reset unless the transcript holds ≥ 2
  messages and is not mid-run, so a single never-persisted message (failed
  `chat.send`) survives.
- **History on load is driven by a client probe**, not a library behaviour:
  `apps/web/app/page.tsx` mounts `useTransport` (from
  `@science-studio/transport-client`), which POSTs the empty-command request on
  mount and imports the folded snapshot via
  `runtime.thread.importExternalState`. The same hook also mounts the standing
  watch behind the SAME guarded-import interlock (see Architecture rules). That
  probe **must end with `data: [DONE]`**
  (the service always writes it), otherwise the import never settles and the
  composer stays locked. The same is true for any run whose flow never ends —
  the kit's flow must be ended on a terminal runtime event (`SessionBehavior.apply`
  returns `settled`) and immediately for empty command batches.
- The service fold seeds its mirror from the claimed/`reconcile` state; if a
  client's claimed state already matches the canonical transcript, the probe
  returns only `[DONE]` (no redundant snapshot).
- **Token streaming**: the openclaw adapter maps gateway `chat` `delta` events
  (`ChatDeltaEvent.deltaText`) to `stream-text` deltas that grow the message's
  trailing text part; the wire fold emits a small `append-text` op at the exact
  `messages/<id>/parts/<i>/text` path (never whole-message rewrites per token),
  and `replace:true` deltas become `set`. Tool calls are streamed as
  `agent`/tool events coalesced into ONE `tool-call` part per `toolCallId`
  (start + result merged) in event order; the `final` chat snapshot is only
  used as a fallback when nothing was assembled live.
- **dsh differs from openclaw in wire-relevant ways**: (1) the dsh
  adapter spawns a LOCAL harness (`dsh --profile sdk` via
  `@deepseek-ai/dsh-sdk-client@0.1.5-alpha.1`, pinned exactly) instead of
  connecting to a gateway — and the agent's working directory is the ACTIVE
  PROJECT's workspace, derived at init from the workspace seam
  (`Workspace.toAgentPath("")`, i.e. the same directory the Files panel lists).
  That holds because the service provisions one adapter — and so one harness
  child — per Project, each initialized with its own Project's workspace
  (docs/adr/0008); one shared adapter could only ever serve the default
  Project. Only a `NullWorkspace` deployment (no `PROJECT_ROOT`) falls back to
  `DSH_WORKSPACE`/`process.cwd()`, because its empty answer is not a
  launchable cwd. Reading the raw `DSH_WORKSPACE` env var here is a foot-gun:
  the dev script points it at the Project PARENT, so the agent worked beside
  `<PROJECT_ROOT>/<projectId>/` while the panel listed that (empty) subdir;
  (2) events arrive per COMMITTED log event, not per
  token — each step's `assistant/message` becomes a whole-message `set`, so
  replies render step-granular and the adapter never fabricates
  `stream-text`/`append-text` token fragments; (3) the SDK wire has no
  history-replay request, so the adapter persists its OWN transcript mirror
  (`DSH_TRANSCRIPT_DIR`, default under the service tmp dir) and cold-restores
  from it — an unverifiable empty transcript is never reconciled against a
  claiming client (docs/adr/0004); (4) SDK `session/prompt` is CREATE-ONLY — a
  NEW harness child cannot create a session id an earlier process already
  persisted in the harness home (`session "<id>" already exists`), so every
  harness id is minted inside ITS child's generation
  (`sessionKey-<ts>-<rand>`, one generation per adapter init, reused by that
  child's later turns): a restart's first prompt is always creatable — no
  rejected prompt, no error log — and the `already exists` failure is retried
  once on a fresh id only as a net for a same-instant collision; the UI
  transcript mirror is unaffected, but the AGENT forgets pre-restart turns.
  (5) `subscribe` pushes a baseline on attach — warm sessions synchronously,
  COLD sessions (service restart, nothing in memory) asynchronously from its
  own mirror — and one snapshot after every settled run, so a watcher that
  attached before any content still wakes on the first settle instead of
  hanging on an open stream (dsh has no remote settles to coalesce).
  assistant-ui mints a per-page local `threadId` (`__LOCALID_*`) on send
  while the mount probe sends none. Each adapter's `resolveSessionKey` maps
  those (and absent ids) to its own default session, but only for clients that
  scope nothing in the URL — the web app's URL carries the selected Session and
  the service's query-first read makes it win, so the runtime-agnostic service
  only funnels the id through and probe history and sends always converge.
- Service-adjacent verification without the browser:
  `curl -sN -X POST http://localhost:3001/api/transport -H 'content-type: application/json' -d '{"commands":[{"type":"add-message","message":{"role":"user","parts":[{"type":"text","text":"hi"}]}}]}'`
  — with a live gateway this streams real frames and must terminate with `[DONE]`.
- **One in-flight run per session.** A second `POST /api/transport` for the same
  session while one is running is refused with **409**: an adapter attaches one
  flow per Session (`SessionRuntime`), so concurrent runs would corrupt both
  streams. Run control reaches the adapter through `POST /api/transport/abort` and
  `POST /api/transport/approve`; `/approve` answers **501** when the runtime has
  no approval surface (`RuntimeAdapter.approve` is optional).

## Architecture rules

- **Record is authoritative.** Science Studio owns the research record — in v1
  `Project`/`Session`/`Run` (`Study`/`Task`/`Artifact`/`Evidence`/`Conclusion` are
  deferred, docs/adr/0007); runtimes are adapters behind a transport seam
  (docs/adr/0002).
- **Seam is `RuntimeAdapter`** (`packages/transport`). The frontend only speaks
  assistant-ui's `useAssistantTransportRuntime` protocol; backend transport-service
  delegates to a registered adapter (docs/adr/0001).
- **Seam *interfaces* live in a seam package — runtime seams in
  `packages/transport`, record seams in `packages/record` — and implementations
  live in their own packages** (runtime packages own their bindings/factories,
  the workspace package owns `FsWorkspace`; `record` owns its store
  implementations). No cycles. `transport` has two entries:
  `./seams` is the contract alone (interfaces + their error classes + limit
  constants) and `.` adds the shared kit and the pure single-user defaults —
  implementers that only need the interface import `./seams`.
  The composition root loads
  runtimes DYNAMICALLY (`SS_RUNTIME_MODULES` → each module's `runtimePlugins`),
  and the DEFAULT list is data in the service's `package.json`, so adding a
  runtime touches no core *code* — and the private enterprise
  module is loaded the same way (`SS_ENTERPRISE_MODULE`). See
  docs/design/implementation-plan.md §5 for the CI invariants. The
  `@science-studio/contract-tests` package publishes the executable form of
  these invariants: implementers (including the private enterprise module) run
  its suites.
- **A runtime's launch surface belongs to its package.** `RuntimeInitOptions`
  carries an opaque `RuntimeBinding` (+ optional `workspace`/`env`), never a
  `{url, token}`; only `transport-openclaw`/`transport-dsh` know their own shape.
  `RuntimeAdapter.approve` is OPTIONAL — gate it on `capabilities.approvals`.
- **`Run` is the atomic traceable unit**; each Research turn produces one.
- **Session identity is record-owned.** A runtime session key IS the Science
  Studio `Session` id (1:1). `POST /api/projects/:id/sessions` creates one
  explicitly, and `POST /api/transport` also resolves-or-first-use-records the
  claimed key under the request's Project (optional `projectId`; omitted → the
  auto-ensured `project-default`) — building `SessionState`
  (`sessionId`/`projectId`/`agentId`) from the record, never from fabricated
  constants. The **workspace is project-scoped and so is the runtime**: the
  service acquires the Project's `Environment` — one workspace AND one adapter per
  Project, the adapter initialized with that Project's workspace (docs/adr/0008),
  which is what makes the dsh child's cwd the Project's own directory — and only
  then maps the claimed `threadId` through the
  adapter's `resolveSessionKey`. The adapter persists `Run`s through a narrowed
  view of the SAME `RecordStore` the service reads identity from (`records` on
  `Backend`; both `localBackend` and the `{ adapters }` compat path share one
  instance).
- **The remembered scope is chrome state, and it is only trusted after the record
  confirms it** (docs/adr/0009). `apps/web/lib/scope-memory.ts` keeps
  `{lastProjectId, sessions}` per browser in one versioned `localStorage` blob;
  `setScope` on `studio-store.ts` is the ONLY way the scope changes, moving the
  store, the memory and the URL together. Resolution prefers the URL's claim when
  the record lists it, else the remembered Project, else the first Project, and a
  Session from that Project's list (else its newest). It runs BEFORE the shell
  renders: an unvalidated Session must never mount, because the mount probe
  (`resolveOrCreateSession`) MINTS the Project and Session rows for an unknown key
  rather than refusing it. Only an authoritative "no" prunes — a fetch failure
  leaves the memory alone. The URL is MIRRORED with `history.replaceState`, never
  navigated: a router navigation across route segments remounts the runtime owner
  (and a mid-run switch then hits the one-in-flight-run 409).
- **Keep the transport package React-free.** The shared client package
  (`@science-studio/transport-client`) owns the assistant-ui boundary as ONE
  session module: `useTransport` mounts the mount-time history probe and the
  standing watch behind a single guarded-import interlock (adopting
  canonical-snapshot pushes — remote turns and native command replies, which
  never stream over a run channel), plus the command catalog and the
  slash-menu / reasoning-trace helpers; the web app and both examples use it,
  and each app owns only its Thread UI/skin. **The component that calls
  `useTransport` must never re-render**: assistant-ui rebuilds its internal
  thread-list adapter on every invocation, so a re-render of the owning
  component reads as an adapter swap — it tears the active thread down and
  starts an empty one, wiping the transcript (recovered only by a reload). Keep
  the hook's host state-free and memoized, with all UI state in a child below it
  (`apps/web/app/page.tsx`); `apps/web/test/workspace-panel-history.test.mjs` is
  the regression guard. **Its two stream requests (the mount probe and the
  standing watch) are aborted on unmount** — the watch is an NDJSON stream that
  never ends by itself, and the runtime is remounted on EVERY scope change (twice
  per mount under dev StrictMode), so an un-aborted one is never reused: ~6
  orphans fill the browser's per-origin connection pool (HTTP/1.1) and from then
  on NO request to this origin can even start — the session list, the file
  listing and the probe all queue forever and the workbench looks frozen
  (the symptom of docs/adr/0009's scope switching). `apps/web/test/scope-switch-sockets.test.mjs`
  is the regression guard: it serves the watch over a real socket, switches
  Projects repeatedly, and asserts a same-origin request still starts.
- **Adapters compose one shared run lifecycle** in `@science-studio/transport`
  (docs/adr/0005): `SessionRuntime` owns the run loop (reconcile-first, probe
  termination, user echo, flow drain), the settle pipeline (project →
  `RecordStoreLike.addRun` → durability hook → watched notify, with no failure
  escaping the run stream), the watch registry + Run projection, the tool-part
  merge invariant, and the transcript-equality rule. An adapter supplies a
  `SessionBehavior` — its event→delta mapping, its launch surface (`dispatch`),
  and only the hooks it differs on (openclaw: history convergence in
  `history-sync.ts` + `chat.send` + 250 ms coalescing; dsh: `runTurn` + mirror
  restore/save + async cold baseline). Per-adapter code never re-implements the
  loop. The `RunFlow` queue (enqueue-time snapshot clones) is what keeps the
  wire mirror and the client safe from delta referencing live objects.
  **The transcript primitives are constructible**: `createApplyContext(state)`
  builds an `ApplyContext` over a transcript the caller owns, from the same code
  `SessionRuntime` runs — so an adapter's `apply` mapping is tested against the
  real merge rules instead of a copy. A copy inside `transport-dsh` had drifted
  (it merged a tool result but not the later `args` that openclaw sends), and
  nothing caught it because no test drove the rule itself; a behavior test must
  never re-implement `emit`/`ensureMessage`/`mergeToolCall`.
- **Don't hand-roll the gateway WS state machine.** Use
  `@openclaw/gateway-client` / `@openclaw/gateway-protocol` primitives, pinned
  EXACTLY (calendar release train, not semver; `2026.8.1`). Reference
  implementation in `viber-space/openclaw-adapter`.

## OpenClaw specifics (backend adapter)

- Connects as an **operator** client with the shared token. **Connect identity
  must be `id: "cli"`, `mode: "cli"`** — `mode: "operator"` is invalid (mode is
  a transport, not a role); the gateway rejects it with `INVALID_REQUEST`.
  Verified against a live gateway (`hello-ok`).
- Verified against a live gateway: connect/handshake, `sessions.list`,
  `chat.history`, `chat.send` (returns `{ runId, status: "started" }`), event
  streaming. **`chat.send` requires a non-empty `message`**; otherwise the
  gateway answers `INVALID_REQUEST: message or attachment required` (schemas in
  `@openclaw/gateway-protocol/protocol.schema.json`).
- Each run is scoped to its own `runId` (`flow.targetRunId`) so stale/foreign
  runs can't end it prematurely. If the LLM provider (ollama) is unreachable,
  runs stall at `starting_model` and never emit content.
- Mapping is verified against real `chat.history` shapes: assistant
  `{type:"thinking",thinking}` + `{type:"text",text}` blocks and `toolResult` rows.
- Do not advertise `session-scoped-events` — it breaks broadcast streaming.

## Operational gotchas

- Gateway URL/token come from `services/transport-service/.env`
  (`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`; dotenv loads it; the file
  is NOT committed). No `.env` → adapter init fails.
- Adapter init failure is logged (`gateway not ready within 15s`) but the
  server keeps listening; every subsequent request fails. Stale `tsx` processes
  hold port 3001 and can wedge the gateway connection — before restarting, kill
  leftovers (`pgrep -fl "transport-service"`, then `pkill`) rather than piling
  up and masking symptoms with "not ready" verbosity.
- `/api/transport` is served by a **streaming Route Handler** that pipes the
  transport-service body straight through (`apps/web/app/api/transport/route.ts`,
  upstream `TRANSPORT_SERVICE_URL` → `localhost:3001`). Don't replace it with a
  `next.config` rewrite — Next buffers rewrite responses, which destroys the SSE
  token stream (symptom: the whole reply — user message included — appears only
  when the run finishes). When debugging a UI-side issue, test through port 3000
  too; the route handler can behave differently from the direct service.
- **Every `/api` proxy hop relays through ONE module — never `fetch`.**
  `apps/web/lib/service-proxy.ts` (`proxyToService(request, { path, method,
  body, headers, forward })`) owns the policy all of them share: the
  `TRANSPORT_SERVICE_URL` base, the caller's `Authorization` forwarded upstream,
  and the upstream's status and body relayed VERBATIM (a proxy that re-shapes an
  error only hides the service's own diagnosis). Under it,
  `apps/web/lib/stream-proxy.ts` issues the request with `node:http`/`node:https`
  — undici (Node's `fetch`) aborts a response body after **300 s of silence**
  (`UND_ERR_BODY_TIMEOUT`), and the watch is silent BY DESIGN until a run
  settles, so every idle watch died at the 5-minute mark with `failed to pipe
  response` and a 500 (`GET /api/transport/watch … 500 in 302671ms` was the
  tell). `node:http` has no idle deadline; the response is handed over as a
  `ReadableStream`, and cancelling it (tab closed, `useTransport` re-render)
  destroys the upstream socket. Short JSON hops pay nothing for the same relay —
  one policy, no "which one does this route use?".
  `runtime`/`dynamic` stay literal in each route file (Next must statically
  analyze route segment config, so it cannot be re-exported). Each route keeps
  only what is genuinely per-hop: the upstream path + query (the watch is the one
  hop that WHITELISTS its query instead of relaying it), the request body, and —
  for `transport/commands` — the one failure policy: an empty catalog on a
  failed upstream, so the composer degrades to plain chat.
  Note the response HEAD is only flushed with the first body chunk (Next's
  Response plumbing, both before and after this change): a watch that has nothing
  to push shows no TTFB until it does.
- The web UI is the **assistant-ui registry `Thread`** (`shadcn add
  @assistant-ui/thread`, Radix flavor) on Tailwind v4 + shadcn/ui, not
  hand-written chat markup. To refresh/upgrade the components, run `npx
  shadcn@latest add "@assistant-ui/thread" -y -c apps/web` (components.json
  maps the `@assistant-ui` registry). `app/layout.tsx` must wrap children in
  `TooltipProvider`. Don't restyle elements with inline styles — the styling
  stack is Tailwind utility classes.
- The assistant-ui Thread only starts a request when the user sends a message;
  history on load is handled by the mount probe in `app/page.tsx` (see wire
  contract above) and by `importExternalState`, so don't add `resumeApi`/
  `resumeStateApi` options to the runtime just to fetch history.
- `@science-studio/record` exports `createInMemoryRecordStore()` (and the JSONL
  store the service uses by default). With `Artifact` out of v1 the adapter seam
  `RecordStoreLike` (and the kit's `RunSink`) is the single method `addRun`, so
  the authoritative `RecordStore` satisfies it directly — but the service still
  wires it explicitly rather than by `as any`, and the ONE `RecordStore` instance
  is deliberately shared by the adapter's sink and the service's
  `records`/project-session directory, so Runs and Sessions land together.
- All five `apps/web` proxies (`app/api/transport/route.ts`, `transport/commands`,
  `transport/watch`, `workspace/[...path]`, `projects/[[...path]]`) forward the
  caller's `Authorization` header upstream — one line in
  `lib/service-proxy.ts` (`forwardedAuth`), so a new hop cannot forget it.
  Single-user installs send none (no login); in hosted mode the enterprise
  `PrincipalResolver` authenticates the bearer, so a proxy that swallows the
  header breaks auth silently. `projects` is the record surface
  (`/api/projects*`) the Projects pane reads, and it is what keeps the browser
  same-origin on port 3000.