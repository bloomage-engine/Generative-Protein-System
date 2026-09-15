# Research Agent Framework — Implementation Plan

Status: active — **Phases 0–2.6 implemented** (`npm run build` green; 235 tests
across the workspace suites green); the startup `PROJECT_ROOT` scan is the one
remaining 2.6 item. Companion to [`research-agent-framework.md`](./research-agent-framework.md)
(design rev 4) and [`research-agent-framework.zh.md`](./research-agent-framework.zh.md).

Strategy: **single-user first, end to end.** Multi-user is never built now; it
only ever *implements seam interfaces* reserved in the OSS core. Every phase
below must leave the OSS product complete, building, and green with no
enterprise module present.

---

## 1. Seam-types rule (correction to design §11)

The design placed seam interfaces across three packages, which would make
`transport` reference `Workspace` from `workspace` while `workspace` references
`transport` — a cycle. Fix: **seam *interfaces* live in a seam package — the
runtime seams in `@science-studio/transport`, the record seams in
`@science-studio/record` — and implementations live in their own packages**
(docs/adr/0006, 0007).

| Package | Holds | Depends on |
| --- | --- | --- |
| `packages/record` | **The record seam.** `Id`, `Project`/`Session`/`Run` + `RunStatus`, the `RecordStore` contract, and its implementations (in-memory for tests, JSONL used by default) | nothing |
| `packages/transport` | **Two entries.** `./seams` = the contract only: `RuntimeAdapter`, `Workspace`, `Principal`/`PrincipalResolver`, `Environment`/`EnvironmentProvider`, `Sandbox`/`SandboxProvider`, `RuntimeBinding`/`RuntimeFactory`/`RuntimeCapabilities`, `QuotaPolicy`, `SecretStore`, plus their error classes and limit constants. `.` = that contract **+ the shared kit** (`Transcript`/`RunFlow`/`foldState`/attachment helpers) **+ the pure single-user defaults** (`LocalPrincipalResolver`, `LocalEnvironmentProvider`, `NullWorkspace`, `NoopQuotaPolicy`). Exports are explicit (no `export *`). | `record` only |
| `packages/workspace` | `FsWorkspace`, file-reference grammar, limits enforcement | `transport` |
| `packages/sandbox` | `LocalSandboxProvider`, `DshSandboxProvider` | `transport` |
| `packages/transport-openclaw` / `-dsh` | binding types + factories + adapters | `transport` |
| `services/transport-service` | Fastify plugins, composition root, routes | `transport`, `workspace`, `sandbox` |

No cycles; a runtime package and the private enterprise module both sit at the
same level, implementing `transport` interfaces.

## 2. What "single-user done" means

A local install with no login:

- browser → **one Fastify process** (`transport-service`) → openclaw or dsh
  adapter, chosen by configuration;
- a **workspace file service** on the same process: browse a Project directory
  (one workspace per Project, shared by its Sessions), `@`-mention
  files/directories as references, open agent-returned file links;
- records (`Project`/`Session`/`Run`) in a file-backed store by default;
  `Study`/`Task`/`Artifact`/`Evidence`/`Conclusion` deferred;
- **zero enterprise code loaded**, and the test suite is green with
  `SS_ENTERPRISE_MODULE` unset.

## 3. Reserved extension points

Every seam has a working single-user default today and a known multi-user
implementation later. This is the whole multi-user readiness story: we reserve
the *shape*, not the implementation.

| Seam (in `transport`) | Single-user default (OSS) | Future multi-user (private module) |
| --- | --- | --- |
| `PrincipalResolver` | `LocalPrincipalResolver` (constant, no credential) | `BearerPrincipalResolver` (OIDC/JWKS + directory) |
| `EnvironmentProvider` | `LocalEnvironmentProvider` (one adapter + workspace per Project) | `CachingEnvironmentProvider` + `FleetSandboxProvider` |
| `RuntimeFactory` | registered from config; openclaw + dsh factories | same mechanism, unchanged |
| `Workspace` | `FsWorkspace` rooted at `<PROJECT_ROOT>/<projectId>/` | `FsWorkspace` over a cell bind-mount |
| `QuotaPolicy` | no-op (or local `quotaBytes`) | per-tenant usage ledger + reconciler |
| `SecretStore` | mode-`0600` file | secret manager / keychain |
| `SandboxProvider` | `LocalSandboxProvider` | `FleetSandboxProvider` + `SandboxRegistry` |
| `RecordStore` | in-memory (tests) / JSONL (default) | per-tenant Postgres schema |

## 4. Phases

### Phase 0 — seams + Fastify (no behavior change) — ✅ done

Goal: the service is Fastify, everything goes through the principal/environment
preamble, and runtimes plug in through factories. Wire contract unchanged.

1. ✅ `packages/transport`: `workspace.ts` (`Workspace` types, `WorkspaceLimits`,
   `NullWorkspace`, `QuotaPolicy`), `principal.ts` (`Principal`,
   `PrincipalResolver`, `LocalPrincipalResolver`), `environment.ts`
   (`Environment` incl. `sessionKey`, `EnvironmentProvider`,
   `LocalEnvironmentProvider`), `runtime.ts` (`RuntimeBinding`,
   `RuntimeFactory`, `RuntimeCapabilities`, `RuntimePlugin`); exported.
   (`CachingEnvironmentProvider` deferred to Phase 3 — single-user needs no cache.)
2. ✅ `transport/src/types.ts`: `RuntimeInitOptions` drops `gateway` for `binding`
   (+ optional `workspace`, `env`); `RuntimeAdapter.approve` is optional.
3. ✅ `transport-openclaw`: `binding.ts` (`GatewayBinding`,
   `parseGatewayBinding`, `openClawLocalBinding`, `OPENCLAW_CAPABILITIES`) +
   `createOpenClawRuntimeFactory()` + `runtimePlugins`; `init()` reads the
   binding. Test `init()` sites migrated.
4. ✅ `transport-dsh`: `binding.ts` (`DshBinding`, `dshLocalBinding`,
   `DSH_CAPABILITIES`) + `createDshRuntimeFactory()` + `runtimePlugins`; the
   no-op `approve()` is gone (capabilities say `approvals: false`).
5. ✅ `transport-service`: Fastify (`createServer`) with a `preHandler` principal
   hook and CORS; `composition.ts` (`createBackend()` = local default,
   `SS_ENTERPRISE_MODULE` dynamic import, `resolveRuntimePlugins`). Routes hijack
   the Node response for SSE/NDJSON. `createTransportService()` keeps a
   `{ adapters }` compat path for the examples/tests.
6. ✅ `packages/contract-tests`: the shared seam conformance suites
   (`testPrincipalResolver`, `testWorkspace`, `testRuntimeFactory`,
   `testQuotaPolicy`), self-tested against the OSS reference implementations (14
   tests) and ADOPTED by transport-openclaw / transport-dsh for the factory
   contract.

**Done when:** `npm run build` passes; `npm run test` is green with
`SS_ENTERPRISE_MODULE` unset; the service starts without waiting on the runtime
(verified: ~100 ms with an unreachable gateway) and `/api/transport` still
streams frames terminating with `data: [DONE]`.

### Phase 1 — workspace file service (single-user) — ✅ done

7. ✅ `packages/workspace`: `FsWorkspace` implements the seam with the
   containment/symlink/size invariants under test (11 tests). The service's
   `localWorkspace()` wires it from `WORKSPACE_ROOT` (+ `WORKSPACE_AGENT_ROOT`,
   `WORKSPACE_MAX_INLINE_BYTES`); unset means `NullWorkspace` and no file
   surface. `maxUploadBytes` enforcement lands with the upload route.
   *(Revised by docs/adr/0006: the env parent is now `PROJECT_ROOT` — one
   workspace per Project, not one per deployment.)*
8. ✅ `services/transport-service`: **read-only** workspace routes
   (`GET /api/workspace/{entries,stat,file}`), resolved through the environment.
   Errors map onto HTTP: path/escape → 400, missing → 404, over the inline cap →
   413 (and `?download=1` streams any size), no workspace → 503.
9. ✅ `apps/web` + `transport-client`: `useWorkspaceBrowser` / `useWorkspaceFile`,
   `resolveFileReference` + `WorkspaceOpenProvider` (agent file links open in the
   in-app viewer), the markdown `a` override, `artifact` → a `file` chip in the
   converter, the `WorkspacePanel` (browser + text preview + download), and the
   `app/api/workspace/[...path]` streaming proxy. Text inline, download for
   everything else — no binary preview in v1.

**Upload is deliberately NOT here**: it needs a `Workspace.write` method and
quota accounting, and it only earns its keep once `@`-attachments exist (a
workspace file is a *reference*; an upload is for a file not yet in the
workspace). It moves to Phase 2.

### Phase 2 — attachments, upload, and run control — ✅ done

10. ✅ `packages/transport`: `AttachmentRef`, the `file` `MessagePart` variant, and
    `TransportCommand.add-message.attachments`; `normalizeCommands` now lifts
    file-bearing parts into attachments, accepting BOTH the domain part shape
    (`path`/`name`) and assistant-ui's `FileMessagePart`
    (`filename`/`data`/`mimeType`). The converter also renders a `file` part as a
    chip carrying its workspace path.
11. ✅ Adapters render references: shared `renderAttachments` /
    `promptWithAttachments` / `userMessageParts` (transport) make a workspace
    attachment a `file` part on the echoed user message AND a path block in
    `chat.send` / the dsh prompt, mapped through `workspace.toAgentPath()`.
    Mentions: `parseWorkspaceMentions` reads assistant-ui's directive syntax
    (`:file[label]{name=id}`) out of composer text and `attachmentsFromMentions`
    turns them into workspace references (a `directory` mention stays a
    reference), with the directive stripped from the agent-facing text. The
    composer `@` picker is `useWorkspaceMentions` (transport-client), built on
    assistant-ui's `unstable_useMentionAdapter` + `TriggerPopover.Directive`.
12. ✅ `Workspace.write` (bytes or a stream; temp-sibling + rename so a
    failed/over-cap upload never truncates; containment checked on the created
    parent; `maxBytes`/`createParents`/`overwrite` options) with conformance
    coverage, and `POST /api/workspace/upload?path=`. Uploads are a **raw body**
    (`application/octet-stream`), not multipart: one file per request, no parser
    dependency, and the body streams straight into `write`. Enforces
    `maxUploadBytes` (413) and consults `QuotaPolicy` (507) on the declared size;
    returns the resulting `AttachmentRef`.
13. ✅ Per-session run lock (a second concurrent run is refused with 409, so
    `Transcript.attachFlow` can never overwrite a live flow) and
    `POST /api/transport/{abort,approve}` — `/approve` answers 501 when the
    adapter has no approval surface.

### Phase 2.5 — record-backed identity — ✅ done

14. ✅ `RecordStore` gains `addSession`/`getSession` (in-memory impl included).
    `createSessionResolver` (`services/transport-service/src/sessions.ts`) treats
    a runtime session key AS the `Session` id (1:1): first use mints the
    `Session` — plus the default Study it hangs off, from
    `PROJECT_ID`/`STUDY_ID`/`AGENT_BLUEPRINT_ID` — with concurrent first uses
    de-duplicated. `POST /api/transport` resolves identity BEFORE taking the run
    lock and builds `SessionState` from the record, so `persistRun` attributes
    `Run.sessionId`/`agentId`/`taskId` correctly. `Backend.records` is the
    authoritative store; `localBackend` and the `{ adapters }` compat path both
    share the one instance with the adapter's `toRecordStoreLike` view.
    *(Revised by docs/adr/0006/0007: Sessions are created explicitly under a
    Project, `SessionState` carries `projectId`, `Run.taskId` is removed, and
    `Study`/`Task` leave v1.)*

### Phase 2.6 — Project owns the workspace and the Session — 🟡 15–21 done (docs/adr/0006, 0007)

Goal: a `Project` is the container — **one workspace per Project, shared flatly by
its Sessions**, with Project/Session created explicitly — and the record layer is
`Project → Session → Run` on a persistent store. Supersedes Phase 2.5's
env-constant identity.

15. ✅ `packages/record` — the v1 contract. `types.ts` keeps `Id`, `Project`
    (`id`/`name`/`createdAt`/`archivedAt?`), `Session`
    (`id`/`projectId`/`agentId`/`title?`/`createdAt`/`updatedAt`) and `Run` (drop
    `taskId`; add `projectId`; keep `RunStatus`). Delete `Study`, `Task`,
    `Artifact`/`ArtifactKind`, `Evidence`, `Conclusion`, `AgentBlueprint`.
    `RecordStore` = `createProject`/`getProject`/`listProjects`/`archiveProject` +
    `addSession`/`getSession`/`listSessions(projectId)` + `addRun`/`listRuns(projectId)`;
    drop `updateRun`/`addArtifact`/`addEvidence`/`getConclusions`. `memory.ts`
    implements the new surface.
16. ✅ `packages/record` — the JSONL store. `createJsonlRecordStore(path)`:
    append-only log, index rebuilt on load, compaction on start, a torn final line
    skipped (zero new dependencies). Optional follow-on: publish the contract as
    `record/seams` (pure `RecordStore` + types) once the implementations exist,
    mirroring `transport/seams`.
17. ✅ `packages/transport` — the seam changes. `SessionState.studyId` →
    `projectId` (and `SessionRuntime`'s state init + `run()` assignment);
    `Environment.sessionKey` → `projectId` and
    `EnvironmentProvider.acquire(principal, projectId)`; `RecordStoreLike`
    collapses to `{ addRun }` (delete `ArtifactInput`, `RuntimeAdapter.onArtifact`,
    `RecordStoreLike.addArtifact`; `RunSink` = `RecordStoreLike`);
    `RuntimeFactory`/`RuntimePlugin` is UNCHANGED — the request carries
    `projectId` (optional; omitted → the default Project), so the caller acquires
    the environment first and then maps the claimed `threadId` through the
    adapter's own `resolveSessionKey`. Update `packages/contract-tests` for all of
    the above.
18. ✅ Adapters (`transport-openclaw`, `transport-dsh`): drop the artifact path
    and carry `projectId` through `SessionState` (`resolveSessionKey` stays on the
    adapter). **One adapter serves the user, not the Project** — the child cwd is
    the deployment's agent root — so no adapter file changed beyond the shared
    `Run`/`SessionState` types. *(Revised by docs/adr/0008: an adapter's
    workspace-derived launch surface is fixed at `init`, so a shared adapter can
    only serve the default Project — provisioning is per Project.)*
19. ✅ Service composition + directory. `composition.ts`: `PROJECT_ROOT` /
    `PROJECT_AGENT_ROOT`; `RECORD_STORE_PATH` (default
    `$XDG_DATA_HOME/science-studio/record.jsonl`) / `RECORD_STORE=memory`;
    `AGENT_ID` replaces `PROJECT_ID`/`STUDY_ID`/`AGENT_BLUEPRINT_ID`; auto-ensure
    the `project-default` project; on startup, a read-only scan of `PROJECT_ROOT`
    that warns about unregistered directories (record is truth — never
    auto-import). The local environment provider takes an `environmentFor`
    builder and caches one `{ adapter, workspace }` per Project — one workspace
    per Project and (docs/adr/0008) **one adapter per Project**, each initialized
    with its own Project's workspace, built lazily on first use and initialized
    in the background. `createSessionResolver` is replaced by `directory.ts`
    (explicit `createProject`/`createSession`, plus `resolveOrCreateSession` for
    first use). *Not yet done:* the startup scan.
20. ✅ Service routes: `POST /api/projects`, `GET /api/projects`,
    `POST /api/projects/:id/sessions`, `GET /api/projects/:id/sessions`,
    `GET /api/projects/:id/runs` (the Run rollup). `POST /api/transport` acquires
    the environment by `projectId ?? default`, then maps the claimed `threadId`
    through `resolveSessionKey` and finds-or-first-use-records the Session before
    taking the run lock.
21. ✅ Workspace routes take `?project=` instead of `?session=` (omitted → the
    default Project); the workspace served is `environment.workspace` (the project
    root).
22. ✅ `apps/web` + `transport-client`: URL routing
    `/projects/<projectId>/sessions/<sessionId>` (refresh- and share-safe) with a
    `Project/Session` picker on `/`; `useTransport({ projectId, threadId })`
    carries the scope in the transport URL and scopes the watch;
    `WorkspaceApiProvider` carries the Project so `useWorkspace*` and the
    composer's `@` picker browse the project root with `?project=`. **The query
    scope is AUTHORITATIVE over the body**: assistant-ui builds its own send body
    and always puts a per-page local `__LOCALID_*` threadId in it, so a
    body-first read would shadow the URL's Session and resolve every send to the
    adapter's default session (the reply would then reconcile against the wrong
    transcript — the app appears to switch sessions). The body stays the fallback
    for clients that scope nothing in the URL (the mount probe, the examples),
    and the watch proxy forwards `projectId` (not just `project`).
23. ✅ `.env.example` (service) updated for the renamed env: `WORKSPACE_ROOT` /
    `WORKSPACE_AGENT_ROOT` → `PROJECT_ROOT` / `PROJECT_AGENT_ROOT`, documenting
    the per-Project layout (`<PROJECT_ROOT>/<projectId>/`). The examples need no
    change: they omit `projectId` and land on the default Project. *(The
    `DSH_WORKSPACE` alignment caveat this item shipped is gone: with one adapter
    per Project (docs/adr/0008) the dsh child's cwd is the Project's own agent
    directory.)*

**Done so far:** `npm run build` is green; every workspace suite passes
(record 4, transport 48, workspace 18, contract-tests 15, transport-client 27,
openclaw 50, dsh 27, service 41, examples 3 + 2) except a known FLAKY
`transport-openclaw` subscribe test under full-suite load; `POST /api/projects` +
`POST /api/projects/:id/sessions` yields a session whose workspace is
`<PROJECT_ROOT>/<projectId>/`, and its agent's cwd is the SAME directory (one
adapter per Project, built lazily — docs/adr/0008); two sessions in one project
see each other's files;
the JSONL store restores the project/session lists and their Runs across a
restart; no `Study`/`Task`/`Artifact` symbol remains in the tree.

**Still to do:** the startup `PROJECT_ROOT` scan (step 19); the service's
`.env.example` rename (step 23 — blocked, see above).

### Phase 3 — enterprise module (private repo, later)

24. `@acme/ss-enterprise`: `BearerPrincipalResolver` + `PrincipalDirectory`,
    `SecretStore`, `FleetSandboxProvider` + `SandboxRegistry`,
    `SchemaRecordStore`, `QuotaPolicy`, enterprise Fastify plugin; wired via
    `SS_ENTERPRISE_MODULE`.
25. Control schema + migration runner; two-tier quotas.
26. Origin-locked CORS; login gate + quota meters in the web UI slot.

## 5. Guardrails (CI)

1. No OSS package depends on any enterprise artifact or names
   `SS_ENTERPRISE_MODULE` outside `composition.ts`.
2. No OSS core package statically imports a runtime package; runtimes are
   registered from configuration, and the DEFAULT module list is data (the
   service's `package.json` `scienceStudio.runtimeModules`), not code.
3. Adding a runtime package touches no core *code* (enforced by a dependency
   check).
4. `./seams` exposes the contract and nothing else: the shared kit and the
   single-user defaults are absent from it (pinned by
   `packages/transport/test/seams.test.ts`).
5. The suite is green with `SS_ENTERPRISE_MODULE` unset.
6. The private repo runs the OSS `contract-tests` suites
   (`@science-studio/contract-tests`) — implemented, and already adopted by the
   two OSS runtime packages.

## 6. Sequencing notes and risks

- **Fastify must not buffer the SSE path.** The transport route hijacks the Node
  response (`reply.hijack()` + `reply.raw`); the watch route is NDJSON and never
  ends. `app.inject()` cannot test an endless response, so the watch test keeps
  a real `listen(0)`.
- **`RuntimeInitOptions` is a breaking change** to ~13 existing test call sites
  (openclaw and dsh); migrate them in the same change as the adapters.
- **Single-user first means no auth branching.** The local resolver returns a
  constant; nothing in the service or UI may assume a credential exists.
- **Reserve, don't build.** No `SandboxProvider` fleet work, no bearer resolver,
  no Postgres in this repo until Phase 3 lands in the private repo.
- **`EnvironmentProvider` becomes project-scoped** (Phase 2.6) — a breaking seam
  change (`acquire` signature + `Environment` shape) the private module and any
  third-party provider migrate in the same release.
- **`PROJECT_ROOT` renames `WORKSPACE_ROOT`** — an existing install moves its
  files under `<PROJECT_ROOT>/project-default/`; a default project is
  auto-ensured so a configured root still works.
- **JSONL crash semantics**: the last appended record may be lost; the loader
  skips a torn final line and compacts on start.
- **dsh gets one harness child per Project** (cwd = the project root), so a
  Project's Sessions share a child; the create-only session-id rule (ADR-0004) is
  unchanged per generation.
