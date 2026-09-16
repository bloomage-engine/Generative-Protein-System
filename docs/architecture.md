# Science Studio — System Architecture

A research-agent platform for computational life-science R&D. Researchers and
managers run and observe agent-driven work with full traceability: every agent
action lands as a reproducible, attributable research record.

This document captures the agreed framework. The domain vocabulary lives in
`/CONTEXT.md`; hard-to-reverse decisions live in `/docs/adr/`.

## 1. Positioning

- **Integrated platform (C)**: agent execution + a research-record layer. The
  management layer is thin; the agent layer is thick. Science Studio's
  differentiator is *experiments reproducible, conclusions auditable*.
- **Domain (X)**: computational / in-silico work first — analysis, modeling,
  literature, hypothesis generation. Wet-lab / instrument integration is
  deferred. Managerial governance is a thin cross-cutting layer.
- **Interaction**: conversation-first. Every Researcher turn is captured as a
  `Run` and persisted by a Science Studio-owned record layer.
- **Units**: `Run` (one Agent execution in a Session) is the atomic traceable unit.
  A `Project` owns its Sessions and shares what they produce, so a Project's record
  of results is the Runs of all of them (`docs/adr/0006`, `0007`).

## 2. Monorepo layout

npm-workspaces TypeScript monorepo. Three hard rules shape the layout: **seam
*interfaces* live in a seam package — the runtime seams in `packages/transport`,
the record seams in `packages/record` — and implementations live in their own
packages** (no cycles); **a runtime's launch surface belongs to its own package**
(the core never names a `url`/`token`/child handle); and **the record layer's v1
vocabulary is `Project → Session → Run`** (`docs/adr/0007`).

```
science-studio/
├── apps/
│   └── web/                            Next.js 15 frontend (assistant-ui Thread + Files panel, :3000)
│       ├── app/page.tsx                Session (runtime owner) + WorkspaceShell (UI state)
│       ├── app/api/{transport,workspace}  streaming Route Handlers (never next.config rewrites)
│       ├── components/assistant-ui/    Thread elements from the assistant-ui registry
│       ├── components/workspace/       workspace browser/viewer panel
│       └── test/                       Playwright regression (panel re-render keeps history)
├── packages/
│   ├── record/                         record seam: Project/Session/Run + RecordStore (memory & JSONL)
│   ├── transport/                      SEAM PACKAGE, two entries:
│   │   ├── ./seams                     the contract alone — interfaces + error classes + limits
│   │   └── .                           the contract + the shared adapter kit + pure single-user defaults
│   ├── workspace/                      Workspace implementations (FsWorkspace + containment/symlink/size invariants)
│   ├── contract-tests/                 shared seam conformance suites every implementation runs
│   ├── transport-client/               assistant-ui client boundary (useTransport, workspace hooks, catalog)
│   ├── transport-openclaw/             openclaw adapter — GatewayBinding, factory, capabilities, runtimePlugins
│   └── transport-dsh/                  dsh adapter — DshBinding, local harness child via the SDK, runtimePlugins
├── services/
│   └── transport-service/              backend assistant-transport service (Fastify, :3001) — composition root
├── examples/
│   ├── transport-openclaw-example/     minimal assistant-ui app over the openclaw adapter (Vite; service :3200)
│   └── transport-dsh-example/          minimal assistant-ui app over the dsh adapter (Vite; service :3300)
├── scripts/                            dev smoke tools (adapter smoke, dsh smoke, SSE replay, …)
├── docs/
│   ├── architecture.md                 this document
│   ├── adr/                            0001–0007
│   └── design/                         research-agent framework + implementation plan (EN/ZH)
├── CONTEXT.md                          domain glossary (authoritative vocabulary)
└── AGENTS.md                           repo & wire-contract operational notes
```

`transport` has two entries on purpose: implementers that only need the
interface import `./seams`; the shared kit and the pure single-user defaults
(`LocalPrincipalResolver`, `LocalEnvironmentProvider`, `NullWorkspace`,
`NoopQuotaPolicy`) live behind `.`. Exports are explicit (no `export *`) and
pinned by `packages/transport/test/seams.test.ts`.

## 3. Data flow

```
① Conversation path (a client-driven run)
   apps/web  assistant-ui Thread
     useTransport  (transport-client: mount probe + standing watch, one interlock)
       │ POST /api/transport  { commands, state, threadId }
       ▼
     app/api/transport/route.ts        streaming Route Handler (forwards Authorization)
       ▼
     transport-service :3001            composition root picks the runtime
       │ RuntimeAdapter.run(session, commands) → AsyncIterable<StateDelta>
       │ wire fold → `set` / `append-text` ops → SSE frames → data: [DONE]
       ▼
     RuntimeAdapter (openclaw: gateway WS | dsh: local harness child)
       └─ every research turn ⇒ one Run persisted via RecordStoreLike

② Watch path (content that settles with no local run)
     GET /api/transport/watch (NDJSON)
       │ baseline on attach + one canonical WatchSnapshot per settle
       ▼
     transport-client adopts it via importExternalState (same guarded interlock)

③ Workspace path (opt-in; one workspace per Project, read + raw upload)
     GET  /api/workspace/{entries,stat,file}          POST /api/workspace/upload?path=
       (Project claim: query projectId | project, else body, else project-default)
       ▼
     app/api/workspace/[...path] proxy → transport-service → FsWorkspace(project) | NullWorkspace
```

The frontend only ever speaks assistant-ui's assistant-transport protocol; the
converter maps Science Studio's normalized state to assistant-ui messages. The
UI is never rewritten when the runtime swaps.

All three streaming hops above are relayed by `apps/web/lib/stream-proxy.ts`,
never by `fetch`: a relay must impose no idle deadline (undici's `fetch` aborts a
body after 300 s of silence, and the watch is silent by design between settles),
and cancelling the relayed stream — a closed tab, a `useTransport` re-render —
must destroy the upstream socket. The short JSON proxies keep using `fetch`.

## 4. The transport seam

### RuntimeAdapter

`RuntimeAdapter` (`packages/transport/src/types.ts`) is the runtime-agnostic
boundary. It consumes a normalized `SessionState` and a batch of
`TransportCommand`s and drives the concrete runtime, yielding `StateDelta`s that
the transport-service folds into client-safe state operations:

```ts
interface RuntimeAdapter {
  runtime: string;                                  // e.g. "openclaw"
  init(opts: RuntimeInitOptions): Promise<void>;    // called once on registration
  run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta>;
  abort(reason?: string): void;
  approve?(approvalId: string, decision: "approve" | "reject"): void; // gate on capabilities
  listCommands?(): Promise<CommandDescriptor[]>;    // slash-menu catalog (ADR 0003)
  resolveSessionKey?(threadId: string | null): string; // canonical session a client threadId targets
  subscribe?(sessionId: string, sink: (snapshot: WatchSnapshot) => void): () => void; // standing watch
}
```

- **Reconcile-first.** Every `run()` starts by yielding a `reconcile` delta that
  carries the adapter's canonical transcript. The transport-service compares it
  against the state the client claimed in the request body (`state`) and, when
  they differ, streams a whole-message-map `set` snapshot — so a fresh page load
  or a reload always converges to the full history (the client needs no
  per-request history fetch beyond a mount-time probe). openclaw additionally
  re-syncs against gateway `chat.history` at the START of every `run()`: the
  gateway is not the only writer, so remote turns (including their USER rows,
  which never pass through this process) are converged by rebuilding the
  transcript whenever the history is not a content-prefix of it.
- **Client-safe ops.** The assistant-ui client accumulator accepts only `set`
  and `append-text`, so the transport-service materializes purely incremental
  deltas (`add-part`, `append-text`) into full `parts` `set` ops and never emits
  raw `append`. Token fragments grow a single text part at its exact path.
  Adapters map their runtime's events into `StateDelta`s.
- **Session identity is record-owned.** A runtime session key IS the Science
  Studio `Session` id (1:1). A Session is created explicitly under a Project
  (`POST /api/projects/:id/sessions`), and the adapter persists `Run`s through a
  narrowed view (`RecordStoreLike`) of the SAME `RecordStore` the service reads
  identity from. `EnvironmentProvider.acquire` is project-scoped, so the adapter
  and workspace are cached per Project (`docs/adr/0006`, `docs/adr/0008`) — the
  adapter is initialized with that Project's workspace, which is where its agent
  works (the dsh child's cwd, and the root every attachment path maps through).

### Runtime plurality

The seam carries HOW a runtime plugs in without the core learning a launch
surface (`packages/transport/src/runtime.ts`):

- `RuntimeBinding` — opaque connection material, `config`'s shape private to the
  runtime package (openclaw: `{url, token}`; dsh: harness spawn options).
- `RuntimeFactory` — `create(binding)` + declared `RuntimeCapabilities`.
- `RuntimePlugin` — the single export a runtime package publishes
  (`runtimePlugins: RuntimePlugin[]`), whose `localBinding(env)` builds the
  single-user binding (the `LocalSandboxProvider` role, kept in the package).
- `RuntimeCapabilities` — traits consumers need up front (`commandCatalog`,
  `remoteSettleWatch`, `tokenStreaming`, `approvals`, `hostedSandbox`,
  `perSessionCwd`), so no consumer hardcodes a runtime's name.

The **composition root** (`services/transport-service/src/composition.ts`) loads
runtime modules DYNAMICALLY by specifier, so the service statically imports NO
runtime package. The default module list is DATA — `scienceStudio.runtimeModules`
in the service's own `package.json` — and `SS_RUNTIME_MODULES` overrides it
entirely. `SS_ENTERPRISE_MODULE` swaps in the private multi-user backend; unset
means the complete single-user product.

### Shared adapter kit

Both shipped adapters **compose** one shared `SessionRuntime`
(`packages/transport/src/session-runtime.ts`, kit tier — see docs/adr/0005)
rather than re-implementing the run lifecycle. The module owns the run-loop
skeleton (reconcile-first, probe termination, user-row echo, flow
attach/drain), the settle pipeline (project → `RecordStoreLike.addRun` →
durability hook → watched notify) with the invariant that no persist or hook
failure escapes into the run stream, the watch registry (baseline on attach,
one sink set per Session, coalescing window), the Run projection skeleton, the
tool-part merge invariant (one `tool-call` part per id, merged never appended),
and the transcript-equality rule.

Each adapter supplies a `SessionBehavior`: its event→delta mapping, its launch
surface (`dispatch`), and only the hooks its runtime genuinely differs on —
openclaw: history convergence (`history-sync.ts`), the command-run guard, 250 ms
notify coalescing and fire-and-forget persistence; dsh: the harness turn (on a
generation-scoped harness session id) plus transcript mirror restore/save,
immediate notify and an asynchronous cold baseline. Which `threadId` means
which session is answered by the selected adapter's `resolveSessionKey` (each
runtime's namespace and default session travel with it, never with the
service).

### Standing watch

`GET /api/transport/watch` keeps open browsers converged by pushing the canonical
`WatchSnapshot` — on attach (baseline) and on settles. openclaw coalesces remote
settles (its transcript is re-synced from `chat.history`); dsh baselines warm
sessions synchronously and COLD sessions (service restart, nothing in memory)
asynchronously from its own mirror, then pushes once per settled run — so a
watcher that attached before any content still wakes on the first settle instead
of hanging on an open stream. On the client, `useTransport` mounts the mount-time
history probe AND the watch consumer behind ONE guarded-import interlock
(`canImportThread`): `importExternalState` is a whole-replace, so imports are
skipped while a local run is active, and the probe additionally requires an empty
thread so an older in-flight snapshot never clobbers a newer watch push.

### The client boundary

`@science-studio/transport-client` owns the assistant-ui boundary as ONE session
module: `useTransport` (probe + watch + guarded import), the command catalog, the
workspace hooks, and the slash-menu / reasoning-trace helpers. The web app and
both examples use it; each app owns only its Thread UI/skin.

**The component that calls `useTransport` must never re-render.** Assistant-ui
rebuilds its internal thread-list adapter on every invocation of
`useAssistantTransportRuntime`, and on a re-render the library reads the new
adapter identity as an adapter swap: it tears the active thread runtime down and
starts an empty one, wiping the transcript (recovered only by a reload). Keep the
hook's host state-free and memoized, with all UI state in a child below it
(`apps/web/app/page.tsx`); `apps/web/test/workspace-panel-history.test.mjs` is the
regression guard.

### Runtime commands (slash commands)

Runtime commands are **plain "/"-prefixed user messages** end-to-end — there is
no dedicated wire command type (docs/adr/0003) — and each adapter decides what a
command MEANS inside its own runtime; the transcript, reconcile and watch paths
treat command rows exactly like any other rows.

- **Command ≠ Run.** A command message is never persisted as a `Run`: the
  openclaw adapter tracks runIds driven by `/`-prefixed sends (remote settles are
  persisted only after the `chat.history` sync, whose transcript guard skips
  settles whose immediately preceding user row starts with `/`), and the dsh
  adapter projects nothing when the Run's input is a command line. The rule
  itself is seam-level: `isCommandText` in the shared kit.
- **Catalog.** `RuntimeAdapter.listCommands()` returns runtime-agnostic
  `CommandDescriptor`s. The openclaw adapter proxies the gateway's
  `commands.list` (60s cached) and curates it; the dsh adapter publishes its own
  two commands (`/status`, `/new` — answered from its own state, with no harness
  at all) and MERGES them with the harness's own registry, which it reaches over
  a private command bridge: a dependency-free cordis plugin it ships into the
  harness child with a per-launch profile patch, serving `GET /commands` and
  `POST /execute` on a process-private socket (docs/adr/0010, docs/adr/0011).
  That registry is agent-scoped and an agent needs a prompt, so while the child
  is COLD the harness layer is a curated list of the pinned profile's own
  commands — the menu is complete from the first page load, and the live catalog
  replaces the curation the moment it answers. A local name wins a collision.
  The transport-service exposes the catalog
  at `GET /api/transport/commands` (JSON) — per Project, like every other route,
  since one adapter serves each Project (docs/adr/0008) — and the web route
  handler relays the query verbatim.
- **Execution.** openclaw sends the invocation text to its gateway; dsh answers
  its own two locally and resolves every other name against the harness's own
  registry — over the bridge when the session has an agent, and as that session's
  FIRST PROMPT when it has none (the plugin intercepts at `agent/pre-step`, runs
  the registry, and rejects the step, so the model never sees a command line).
  An unknown or malformed command line is answered rather than passed to the
  model. No path prompts the MODEL for the command itself, and a harness command
  that submits a prompt (`/plan <message>`) still records no `Run`.
- **Frontend.** `useRuntimeSlashMenu` (transport-client) fetches the catalog
  through `TransportApiProvider` (API base + Project) and builds the assistant-ui
  slash adapter; the web composer and both examples only skin the popover. The
  "/" menu opens only while a non-empty catalog is loaded and the thread is idle
  (`slashMenuEnabled`); picking a command appends its invocation text as a normal
  user message, leaving any partial draft untouched. Hand-typed `/commands`
  behave identically. The catalog is re-read when the thread goes idle
  (`useRuntimeCommands` takes an optional refresh token; the web composer passes
  `thread.isRunning`), because a runtime that only knows its commands once warm —
  the dsh harness child — cannot report them before the first run; only a change
  of (API base, Project) clears the list, so a refetch never blanks the menu.
- **Project scaffold & Brief.** A SECOND dependency-free cordis plugin
  (`project-plugin.ts`, docs/adr/0012) rides another per-launch patch. It is a
  no-op unless its patch config carries Project metadata; when it is one, it lays
  down the research layout — idempotent and create-only — and keeps `PROJECT.md`
  current: on `agent/session-start`, on the `/project` command (also curated into
  the cold menu), and through the model-callable `project_update` / `project_log`
  tools plus a `systemPrompt` section telling the agent to maintain it. The record
  stays the authority; the Brief template renders a read-only copy of the Project
  identity the service passes as `RuntimeInitOptions.project`
  (`records.getProject`).

## 5. Record layer

Science Studio owns the research record; it is the source of truth, not any
runtime (`docs/adr/0002`). The v1 record layer is **`Project → Session → Run`**
(`docs/adr/0007`):

- **Project** owns one Project Workspace and any number of Sessions; everything
  its Sessions produce is shared at the Project level.
- **Session** is a conversation under a Project. A Session's id IS its canonical
  runtime session key (1:1), and Sessions are created explicitly
  (`POST /api/projects/:id/sessions`) rather than minted from env constants.
- **Run** is the atomic traceable unit: one Agent execution in a Session, carrying
  its input, output, status, agent, parameters (token usage) and timestamps. A
  Project's Runs — the turns of all its Sessions — are its shared record of
  results, read back through `listRuns(projectId)`.

`Study`/`Task`/`Artifact`/`Evidence`/`Conclusion`/`AgentBlueprint` are named and
agreed but **deferred** — no entity, no API, no rendering — until their real
producer or reader is designed (CONTEXT.md, "Deferred vocabulary").

`RecordStore` (`@science-studio/record`) is the record-layer seam: the interface
an out-of-tree implementer (the private enterprise module) supplies, alongside a
dependency-free JSONL store the single-user service uses by default
(`RECORD_STORE_PATH`; `RECORD_STORE=memory` opts out).

**The streamed transport state is Science Studio's own normalized Session state**
(`SessionState`: `sessionId`/`projectId`/`agentId`), not a runtime transcript. The
frontend `converter` reads that normalized state; runtime adapters translate
runtime events (e.g. openclaw chat/agent frames) into updates to it. This keeps
the converter runtime-agnostic and the record authoritative.

## 6. Workspace file service

A **Project** owns one workspace — an `FsWorkspace` (`packages/workspace`) rooted
at `<PROJECT_ROOT>/<projectId>/` and shared flatly by every Session of that Project
(`docs/adr/0006`). The agent's cwd and the browser's root are both the project
root, so paths map 1:1 — the service provisions one runtime adapter per Project,
initialized with that Project's workspace, which is what puts the agent there
(`docs/adr/0008`); the directory name is the project id. Workspace access is
**opt-in**: unset `PROJECT_ROOT` means `NullWorkspace` and no file surface (every
request answers 503). `PROJECT_AGENT_ROOT` is the agent-side counterpart of the
host-side `PROJECT_ROOT`.

- Routes: `GET /api/workspace/{entries,stat,file}` and
  `POST /api/workspace/upload?path=` (a **raw** body, one file per
  request — no multipart parser). The Project is read by the ONE shared claim
  rule (`services/transport-service/src/project-scope.ts`): the query's
  `projectId`, else the query's `project`, else the body's, else
  `project-default`. `file` streams inline up to
  `WORKSPACE_MAX_INLINE_BYTES` (413 over it) and `?download=1` streams any size; a
  missing path is 404, a traversal/absolute path 400. Upload answers 413 over
  `WORKSPACE_MAX_UPLOAD_BYTES` and 507 from `QuotaPolicy` on the declared size
  (`WORKSPACE_QUOTA_BYTES`).
- Client-side: `useWorkspaceBrowser` / `useWorkspaceFile` /
  `useWorkspaceAvailability` / `useWorkspaceMentions` and `WorkspaceOpenProvider`
  (the seam that lets an agent file link in markdown open the viewer instead of
  navigating). The composer `@` picker inserts assistant-ui directive text
  (`:file[label]{name=id}` / `:directory[...]`) which the service lifts back into
  a workspace `AttachmentRef` — a directory stays a reference, never expanded.
  All of these are keyed by project.

## 7. Version 1 scope

- Conversation-first: a Researcher chats with a configured Agent in a `Session`
  under a `Project`; each research turn produces a `Run` in the record layer,
  rolled up at the Project level.
- Backend transport service as a composition root; two shipped runtimes
  (openclaw, dsh) behind the same seam; a private enterprise module swaps in the
  multi-user backend.
- One Project Workspace per Project, shared by its Sessions; opt-in via
  `PROJECT_ROOT`.
- `Study`/`Task`/`Artifact`/`Evidence`/`Conclusion`/`AgentBlueprint` deferred.
- `Workflow` (DAG) orchestration is a later overlay, not in v1.

## 8. Open questions (non-blocking)

- Persistence details for the record layer beyond the JSONL store (Postgres
  schema, artifact storage backend) and when to graduate from JSONL.
- Auth model for Managers vs Researchers (scopes, device pairing); the hosted
  `PrincipalResolver` seam exists, the full model is deferred.
- Per-runtime hosted sandbox provisioning (`hostedSandbox`, per-project cwd).
