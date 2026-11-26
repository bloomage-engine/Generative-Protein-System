# AGENTS.md

npm-workspaces TypeScript monorepo. Artifacts (commit messages, README, docs,
ADRs, AGENTS.md, design specs) are written in English; conversation happens in
Chinese.

## Structure

```
apps/web                          Next.js frontend (assistant-ui Thread UI, port 3000)
  app/page.tsx                      the SPA home — resolves the Project/Session scope (URL claim, else the remembered one, validated against the record), then renders the workbench
  app/projects/[projectId]/sessions/[sessionId]/page.tsx  the same workbench, scoped by the route
  app/api/{transport,workspace,projects,cron,hpc}  proxies to the service — every hop relays through ONE policy module (lib/service-proxy.ts: base URL, forwarded auth, verbatim status/body) which never uses next.config rewrites (they buffer) nor `fetch` (its 300 s body deadline kills an idle stream; the relay is lib/stream-proxy.ts)
  components/studio                 the workbench shell: top bar (its two switch buttons give the LEFT slot to the conversation or the Projects pane), Projects pane (create Project + Session over `/api/projects*`; a click EXPANDS a Project for browsing, a DOUBLE click on a Session opens it — expanding must not move the scope, so the conversation and the file tree stay put), file tree/preview panes, tab strip, status bar (its Settings dialog's Skills tab lists the dsh skills read-only globally and installs/removes the active Project's own skills — docs/adr/0020); the Subagents module reads the active Session's delegated-agent runs (the optional `RuntimeAdapter.subagents?` surface; dsh implements it from the child's `subagent.*` notifications into a DURABLE per-Session ledger under the transcript dir, so finished runs survive service restarts — restored `running` rows settle to `aborted`) by polling `/api/transport/subagents` through `useSubagents`; the panel's DEFAULT view is a RECENT WINDOW — `running` rows plus the finished ones within it (default 24 h, configurable 1–720 h — a `useSubagentsWindow` client hook that reads a new `subagents.visibleWindowHours` service setting, docs/adr/0015; an out-of-range / non-integer value is a 400 from the service) — with a History toggle for the older runs, and a row double-clicks into the child's own session record (`RuntimeAdapter.subagentTranscript?` — dsh reads the harness's durable child log — over `GET /api/transport/subagents/:childId/transcript`, opened as a synthetic `subagent:<childId>` tab) now showing a Details row (provider, model, started→ended, status, and `stopReason` when the transcript carries it) plus a highlighted Result with the child's final assistant message's text; a fourth dsh child plugin (`subagent-plugin.ts`, docs/adr/0018) instructs the MAIN agent — best-effort, dsh-only, in a real Project and `project-default` alike — to report each delegated subagent's result (a tool result or a settlement notice) as it arrives; the Jobs panel (docs/adr/0024) is a Project-level right-pane section polling `GET /api/hpc/jobs?projectId` through `useHpcJobs` (5 s; the ledger is the read model — it never shows live cluster state a GET fetched), listing Compute Job rows non-terminal-first with a Refresh action (forces one poller tick), a per-row Cancel (confirm dialog; warns that the cluster keeps running what it is not told to stop), and a row double-click into a synthetic `hpc:<jobId>` tab (details + stdout/stderr tail viewer); the Settings dialog's HPC tab edits the deployment's endpoint list over the settings `hpc` section (manager-gated PUT) and the active Project's binding over `GET|PUT /api/hpc/binding`; the Settings dialog's MCP tab (docs/adr/0026) edits the dsh-only deployment MCP catalog — global rows for every Project, project rows for the active one — over `/api/mcp*`, and Test connection probes the current draft; `renderers/StructureRenderer.tsx` is the molecular-structure preview (dynamic `ssr:false` Mol* viewer over `@gps/molstar-viewer`; selections come from the agent's `molql` tool and from selection-mode clicks)
  store/studio-store.ts             the shell's scope + chrome state (projects list, active Project/Session, left view + panel visibility, open tabs)
  components/studio/theme-menu.tsx + lib/color-theme.tsx + lib/theme-catalog.ts  the top bar's ONE theme dropdown: the light/dark appearance (next-themes, `class="dark"` on <html>) and the shadcnblocks color theme, side by side. The color theme is a `data-theme` attribute on <html> (its own provider — a second next-themes instance would shadow `useTheme()` for the whole workbench — stamped by an inline pre-paint script under its own storage key), and `app/themes.css` scopes every token block to `html[data-theme="<id>"]` / `html[data-theme="<id>"].dark` so a theme outranks both `:root` and the next/font class. A theme carries its colors, its fonts and its radius (shadow tokens are deliberately excluded: the app has no `--shadow-*` scale); the fonts resolve through the app's `--font-app-*` variables, which `app/layout.tsx` fills with self-hosted next/font faces (Geist + the 7 most-used theme families, `preload:false` so only the active theme's faces are fetched). BOTH `themes.css` and the catalog are GENERATED by `scripts/generate-shadcnblocks-themes.mjs` from the free registry items (`https://www.shadcnblocks.com/r/theme/<slug>.json`) — 37 of them; `alpine`/`stripe` are Pro (401) — and `test/theme-catalog.test.mjs` pins that the two files agree. `default` is the base stylesheet, so it has no block.
  components/session-view.tsx       providers + the memoized runtime owner; with no scope it renders the chrome alone. Mounts `components/assistant-ui/frontend-bridge.tsx` (the agent tool-call → UI bridge) just inside `AssistantRuntimeProvider`
  lib/frontend-actions              app-local registry mapping a tool name (e.g. `molql`) to a UI handler; `molql.ts` dynamically imports `@gps/molstar-viewer` so molstar never enters the chat bundle
  components/assistant-ui/elements  Thread UI registered from the assistant-ui registry
  components/workspace              workspace browser/viewer panel
  components/ui + hooks + lib       shadcn/ui base, registry helpers
  (Tailwind v4 + shadcn/ui styling stack: postcss.config.mjs, components.json)
apps/desktop                      Electron desktop app (docs/adr/0013, 0015). Main owns window/menu/lifecycle and forks `build/host/host.mjs` — one Node child that runs the transport-service (dsh runtime, plugins INJECTED into createBackend so the esbuild bundle needs no dynamic import) and spawns the Next standalone server as a grandchild, both loopback/ephemeral, reporting ports over IPC. The standalone Settings window is RETIRED: the workbench dialog (Model/Plugins/Agent/Subagents/Thread/Skills/HPC/MCP — the Subagents tab sets the recent-window `visibleWindowHours`, the Skills tab manages dsh skills, docs/adr/0020; the MCP tab manages dsh MCP servers, docs/adr/0026) is the one editor, persisting to the service settings file (`GPS_SETTINGS_PATH` = `<userData>/settings.json`, docs/adr/0015); `<userData>/config.env` is narrowed to paths/extra env vars and main turns it into the child env. Its `test/*.ts` ARE type-checked by the root build's last step (`tsconfig.tests.json`), but the app is not in the root `build` chain; `apps/desktop` has its own build/test/pack scripts. The desktop also ships on Windows x64 (per-user NSIS, built on Windows natively; docs/adr/0028): the packaged host and its child plugins live inside `app.asar` so their ESM externals resolve from `app.asar/node_modules`, `build:host` discovers every `packages/transport-dsh/dist/*-plugin.js` and syntax-checks the output, the dev/start/service launchers are Node scripts (no POSIX shell syntax), `stopHost` sends an IPC shutdown before the Windows `taskkill /T /F` fallback, and Git is resolved from the persisted User/Machine PATH (with `GIT_BINARY` as the override) rather than trusting the GUI's inherited PATH snapshot.
packages/record                   RECORD SEAM PACKAGE: v1 vocabulary is Project/Session/Run only (Study/Task/Artifact/Evidence/Conclusion/AgentBlueprint deferred — docs/adr/0007) + the RecordStore contract + implementations (in-memory for tests; dependency-free JSONL used by default via RECORD_STORE_PATH). transport depends on it for Id/Run/RunStatus
packages/transport                SEAM PACKAGE, two entries. `./seams` = the contract only: every RUNTIME seam interface (RuntimeAdapter/StateDelta, RuntimeBinding/RuntimeFactory/RuntimePlugin/RuntimeCapabilities, Principal/PrincipalResolver, Environment/EnvironmentProvider, Workspace + limits + QuotaPolicy) plus their error classes and limit constants. `.` = that contract + the shared adapter kit (`SessionRuntime` + its `SessionBehavior` / `RunFlow` queue / `foldState` / attachment helpers / `createApplyContext`, the constructor for the transcript primitives so a behavior test drives the SAME merge rules the runtime does) + pure single-user defaults (LocalPrincipalResolver, LocalEnvironmentProvider, NullWorkspace, NoopQuotaPolicy). Exports are explicit (no `export *`); pinned by test/seams.test.ts
packages/workspace                Workspace implementations (FsWorkspace + containment/symlink/size invariants); depends on transport
packages/cron                     @gps/cron — pure, zero-dependency task-document codec: the `.gps/cron/<id>.md` frontmatter + prompt body, the `<id>.log.md` run-log format and the restricted 5-field schedule grammar shared by the service scheduler and the dsh child plugin
packages/hpc                      @gps/hpc — pure, zero-dependency HPC codec (docs/adr/0024, docs/design/hpc-integration.md): the `.gps/hpc.md` Project HPC Binding frontmatter codec, the squeue/sacct-state → ComputeJobState map and the Remote Work Dir / per-job-dir layout constants shared by the service routes/poller and the dsh child plugin
packages/contract-tests          the SHARED seam conformance suites (testPrincipalResolver/testWorkspace/testRuntimeFactory/testAdapterLifecycle/testQuotaPolicy/testResolveSessionKey) every implementation runs, plus the published `sessionState()` fixture a runtime's tests drive (fixtures drift silently otherwise — no test file was type-checked); the OSS reference impls self-test here, the private module and third-party runtimes run the same suites in their CI. Imports the contract from `@gps/transport/seams` (never the kit)
packages/transport-client         assistant-ui client boundary (single `useTransport` session hook = history probe + standing watch + guarded import; state converter; command catalog + slash-menu / reasoning-trace helpers)
packages/transport-openclaw       openclaw runtime adapter — owns its OWN launch surface (`GatewayBinding`), factory, capabilities and `runtimePlugins`; ports gateway WS
packages/transport-dsh            dsh runtime adapter — owns `DshBinding` + factory + `runtimePlugins` (local harness child spawned by @deepseek-ai/dsh-sdk-client, pinned 0.1.5-alpha.1; stdio JSON-RPC). The SDK wire has no command plane, so the adapter answers `/status` and `/new` itself — and reaches the harness's OWN registry (`/compact`, `/plan`, `/goal`, `/feedback`, `/permission`) through `bridge-plugin.ts`, a dependency-free cordis plugin it ships into that child via a per-launch profile patch (`--patch`, a private UNIX socket; docs/adr/0011). The registry is agent-scoped, so a session with no agent yet sends the line as its FIRST PROMPT, which the plugin intercepts at `agent/pre-step` (registry runs it, the step is rejected, the model never sees it) — that is what makes `/plan` and `/goal` work before the first message; while the child is cold the adapter serves a CURATED list of the pinned profile's own commands instead (so the menu is complete from the first page load). A catalog request never starts the child; a user-issued command does. The same `bridge-plugin.ts` also forwards the harness's process-local `agent/assistant-stream` frames (`start`/`chunk`/`end`) as NDJSON over the same bridge socket (`GET /assistant-stream`); the adapter maps `text-delta` / `reasoning-delta` to `stream-text` / `stream-reasoning` and streams a tool call as it is produced (the first `tool-call-delta` adds the part, later deltas grow its args, the assembled block finalizes it), and the durable `assistant/message` finalizes the row (docs/adr/0022). A SECOND dependency-free child plugin (`project-plugin.ts`, docs/adr/0012) rides another per-launch patch: for a real Project (its patch config carries the identity) it lays down the research layout (idempotent, create-only) and keeps the Project Brief `PROJECT.md` current — scaffolded on `agent/session-start` and by a `/project` command (also curated into the cold menu), maintained by the model through `project_update` / `project_log` tools plus a `systemPrompt` section; the record stays authoritative, and the adapter renders its Project identity from `RuntimeInitOptions.project` (the service fills it from `records.getProject`). A THIRD dependency-free child plugin (`cron-plugin.ts`, docs/adr/0017) rides a third per-launch patch: it adds the `schedule_create`/`schedule_list`/`schedule_delete`/`schedule_set_enabled` tools, a `/cron` command (curated into the cold menu) and a `systemPrompt` section that author the same `.gps/cron/` task files the SERVICE scheduler reads — the plugin authors, the service schedules. The adapter also exposes an OPTIONAL skills surface (docs/adr/0020): `skills?`/`installSkill?`/`removeSkill?` scan the harness's ranked skill roots (`<cwd>/.dsh/skills`, `<cwd>/.agents/skills`, `<dshHome>/skills`, `<agentsHome>/skills`) through a pure module (`skills.ts`, the frontmatter codec + rank merge/shadow) WITHOUT starting the child, so a catalog read works while cold; project skills install/remove as `.dsh/skills/<name>/SKILL.md` written through the Workspace seam (containment invariants inherited). The workbench Settings dialog's Skills tab drives it over `/api/skills*` — global roots are read-only, the active Project's own skills are installable/removable, and a runtime without the surface reports unavailable. A FIFTH dependency-free child plugin (`hpc-plugin.ts`, docs/adr/0024) rides a fourth per-launch patch: it registers the five `hpc_*` tools (`hpc_submit`/`hpc_jobs`/`hpc_cancel`/`hpc_logs`/`hpc_files`) and a `systemPrompt` section, and every tool merely FETCHES the service's `/api/hpc/*` — the plugin never touches SSH itself (the service owns remote execution), is mounted only for a real Project, has no `/hpc` command, and gives the agent no binding-write. A SIXTH dependency-free child plugin (`worktree-plugin.ts`, docs/adr/0025) rides a fifth per-launch patch: it registers the `worktree_*` tools (`worktree_list`/`worktree_create`/`worktree_remove`), a `/worktree` command (curated into the cold menu) and a `systemPrompt` section naming the active worktree, and every tool merely fetches the service's `/api/worktrees*` — the service owns git — so it is mounted only for a real Project and cannot change the agent's own cwd. The adapter ALSO mounts the official `@deepseek-ai/dsh-mcp-client` once per enabled MCP server (global + the active Project's rows) through `mcp-patch.ts` and a child env `GPS_MCP_SECRET_CONFIG` (docs/adr/0026); the config is an `!!js` read of that env, so credentials never enter the patch file, and a runtime-level `mcp` capability tells the workbench whether the active runtime consumes the catalog.
packages/molstar-viewer             structure preview + Mol* integration. Compiles the agent's MolQL (Mol* `mol-script`) into a Selection and selects/highlights/focuses it, and draws Mol* measurements (label/distance/angle/dihedral/orientation/plane). Entries `./formats`, `./directive` and `./measurement` are molstar-runtime-free (Node-testable); `.` imports molstar and is browser-only (dynamic `ssr:false`). Exposes `MolqlViewer`/`MolqlViewerPanel`, `applyMolqlSelection`, `applyMolqlToolResult`, `parseMolqlToolResult`, `applyMeasurementToolResult`, `parseMeasurementToolResult`, and the path-keyed viewer registry (`setMolqlViewer`/`getMolqlViewer`/`removeMolqlViewer`). Pinned to molstar 5.9.0
packages/msa-viewer             MSA (multiple sequence alignment) view + interaction (spec docs/superpowers/specs/2026-09-23-msa-viewer-design.md): pure Node-testable codec — ClustalW / Stockholm / aligned-FASTA / unaligned-FASTA / a3m (ColabFold, lowercase insertions stripped) / mmseqs2-`.result` parsers (`./formats`, `sniffFormat`, `isMsaFile`), column statistics + the conservative `isConservedCol` (`./stats`), the `@<project>/<path>/<seqName>@<col>[-<col>]` mention codec (`./mention`), and the grid math — row windowing, span grouping, ruler, band scale, the cost-based plain-text guard (`./grid`); `.` is the React entry — `MsaGrid` (virtualized grid, crosshair, double-click mention, conservation band, conserved/gap column filters), `MsaResultTable` (sortable mmseqs hits with identity/E-value thresholds), `UnalignedList`. Zero deps (react peer), zero molstar
packages/plugins/molql-shared     the shared MolQL tool logic both agent-side plugins import — the tool descriptions, `createMolqlResult`, the `fetchInteractions`/`fetchMeasurements` service helpers, the mention-label handling (`stripMentionLabel`) and `parseSelectionItem`. Pure, framework-free (Node-testable). Deliberately NOT a root workspace; the plugins list it as a devDependency
packages/plugins/molql-tool-dsh   dsh harness plugin registering the `molql` tool (`ctx.tools.register(defineTool(...))`), the `computeInteraction` tool and the `measurements` tool (both fetch the service), and an embedded MolQL skill. Agent-side deployable — deliberately NOT a root workspace and NOT in the root build (own `scripts/sync-skill.mjs` + `tsc`). The `skills` service is OPTIONAL and typed structurally (its module augmentation targets the root cordis copy, which does not merge with this package's)
packages/plugins/molql-tool-openclaw  openclaw gateway plugin registering the same `molql` + `computeInteraction` + `measurements` tools (`defineToolPlugin`; `openclaw.plugin.json`). Agent-side deployable — NOT a root workspace/build. `esbuild` bundles `typebox` into `dist` and `openclaw` is a peerDependency, so the installed plugin has NO runtime deps and `openclaw plugins install` skips its slow/flaky npm step; `scripts/install.mjs` installs from an `npm pack` tarball (a directory install copies `node_modules` recursively) with `--accept-capabilities`. `typebox`/`openclaw` stay devDependencies for the local `tsc`/bundle build and the root-installed `esbuild` is borrowed for the bundle
packages/skills/molql             the canonical MolQL skill (`SKILL.md` + `references/molql-syntax.md`); the single source of truth, copied into each plugin's `skill/` by its `sync-skill.mjs`. Not an npm package (workspaces negations exclude `packages/skills` and `packages/plugins`)
services/transport-service        backend assistant-transport service — Fastify, port 3001. Composition root: `src/composition.ts`. `TRANSPORT_RUNTIME` picks the runtime product; runtime modules are loaded DYNAMICALLY by specifier, so the service statically imports NO runtime package. The DEFAULT module list is DATA — `gps.runtimeModules` in this package's own `package.json` — and `GPS_RUNTIME_MODULES` overrides it entirely, so adding a runtime edits no core code. `GPS_ENTERPRISE_MODULE` swaps in the private multi-user backend; unset = the complete single-user product. It also owns the per-Project scheduled-run surface: `src/cron/{store,routes,scheduler}.ts` — the file-backed `CronStore`, the `/api/cron*` routes, and a `CronScheduler` decorated as `app.cronScheduler` that is started ONLY by `index.ts`'s `isMain` (tests/embedders call `tick()`/`fire()`) and takes the SAME one-in-flight `activeRuns` lock as the transport route (docs/adr/0017), and the molstar-computed `/api/workspace/interactions` route (src/interactions.ts; see the MolQL section), and the HPC surface `src/hpc/{ssh,routes,poller}.ts` — the ONLY SSH client in the product (spawns the system OpenSSH `ssh`/`scp` binaries with ControlMaster; the service never embeds an SSH library), the `/api/hpc/*` routes (submit/cancel/logs/staging/probe + binding read/write, all through `project-scope`), and a `HpcJobPoller` decorated as `app.hpcPoller`, started ONLY by `index.ts`'s `isMain` (tests call `tick()`) — it reconciles the Compute Job ledger from `squeue`/`sacct`/pid-probes every 15 s and is the ONLY thing that asks the cluster for state; panel and tools read the ledger, never SSH (docs/adr/0024).
examples/transport-openclaw-example  minimal assistant-ui example app over the openclaw adapter (Vite + core primitives; dev-only, not in the root build)
examples/transport-dsh-example     minimal assistant-ui example app over the dsh adapter (local harness; dev-only, not in the root build)
scripts/                          dev smoke tools (smoke-openclaw-adapter, replay-sse-frames)
docs/architecture.md              system architecture
docs/design/                      design specs (research-agent-framework EN/ZH + implementation-plan)
docs/adr/                         ADRs (0001 backend transport, 0002 record ownership, 0003 slash commands, 0004 dsh harness, 0005 shared SessionRuntime, 0006 Project is the workspace/sharing unit, 0007 v1 record layer = Project/Worktree/Session/Run + file store, 0008 runtime provisioning is per worktree, 0009 the workbench resumes the remembered scope, 0010 the dsh command catalog is adapter-owned, 0011 dsh commands ride a launch patch bridge, 0012 a dsh plugin scaffolds each Project Workspace and keeps its Brief, 0013 the Desktop App is Electron with embedded servers, 0014 Project/Session lifecycle: rename, reversible archive, irreversible delete, 0015 deployment settings are service-owned, 0016 subagent activity is an optional adapter surface (dsh keeps a durable ledger; addendum), 0017 cron scheduling is service-owned and a task is a workspace file, 0018 a dsh plugin instructs the parent to report subagent results, 0019 durable session and subagent transcript belongs to the record, 0020 dsh skills are configured through the workbench, 0021 the `/api` hop relays and the client surface owns failure policy, 0022 dsh live assistant streaming, 0023 the composer is a Lexical rich-text input, 0024 HPC remote execution is service-owned and a Compute Job is a record entity, 0025 a Worktree is a record-scoped environment dimension, 0026 MCP is a dsh deployment capability, 0027 color themes are generated from the shadcnblocks registry, 0028 the desktop app ships on Windows, 0029 the product is renamed Generative Protein System (GPS))
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
  `DSH_DEFAULT_SESSION` default `gps`; an ambient `DSH_*` wins) before
  `tsx src/index.ts`, so every dev launch — root `npm run dev` included — gets a
  working route, and `dev:dsh` only adds the runtime selector. Those names cannot
  be spelled in `.env`: the harness child reads the LAUNCHER's cwd `.env` as its
  project layer and hard-refuses any `DSH_*`/`XDG_*`/`DYLD_*` key there. Unset
  knobs are a foot-gun — the adapter falls back to
  `deepseek-official`/`deepseek-v4-flash` and the agent's cwd becomes this
  package's source directory. The route's credential NAME (`apiKeyEnv`, e.g.
  `OLLAMA_LOCAL_API_KEY`) is a legal `.env` line and is inherited by the child.
- `npm run dev:desktop` — the Electron shell against the already-running dev pair
  (`DESKTOP_DEV_URL`, default http://localhost:3000). The packaged app instead
  builds `apps/web` with `NEXT_OUTPUT=standalone` (`npm run build:web:standalone`,
  which uses `cross-env` so it works in cmd.exe too) and hosts both servers
  itself. Packaging: `npm run pack -w @gps/desktop` (electron-builder;
  `dmg` on macOS, `AppImage`/`deb` on Linux, per-user x64 `NSIS` on Windows —
  build on the target OS, there is no Wine/cross-build path). In dev the shell
  only loads `DESKTOP_DEV_URL`, so a real turn depends on the already-running dev
  pair's own `.env` route — the workbench settings dialog reaches the service on
  3001 through the web proxy in dev too. In the packaged app the dialog persists
  to `<userData>/settings.json` (`GPS_SETTINGS_PATH`), and `<userData>/config.env`
  now carries only paths/extra env vars (docs/adr/0015). The packaged app needs
  `dsh` on PATH and a route configured in the dialog. On a Linux host whose setuid
  `chrome-sandbox` helper is not root-owned (containers, most CI/dev boxes),
  Electron aborts with "The SUID sandbox helper binary ... is not configured
  correctly"; `scripts/run-electron.mjs` adds `--no-sandbox` ONLY on Linux for
  this (`DESKTOP_ELECTRON_FLAGS=` opts out, and the secure alternative is
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 ...`).
  Electron 44 requires Node >= 22.12 for the build toolchain.
- Record layer: the v1 record is `Project` → `Worktree` → `Session` → `Run`
  (docs/adr/0007, extended by docs/adr/0025). Project/Session/Worktree routes
  live on the same service (`/api/projects*`, `/api/worktrees*`), and the store
  is persistent by default — `RECORD_STORE_PATH` (default
  `$XDG_DATA_HOME/gps/record.jsonl`) — with `RECORD_STORE=memory` to
  opt out. A `project-default` row is auto-ensured so a request that names no
  Project still works, and its `main` worktree row is auto-ensured alongside it
  (`main` is the Project root; a Session with no `worktreeId` normalizes to it).
- Project/Session lifecycle (docs/adr/0014): a Project renames its `name` /
  a Session its `title` (ids are immutable; a Project id names its directory);
  `POST /api/projects/:id/{rename,archive,unarchive,delete}` and
  `POST /api/projects/:id/sessions/:sid/{rename,archive,unarchive,delete}` drive
  it (all POST, so the GET/POST web proxy is unchanged). Archive is a reversible
  flag (`archivedAt`; listings exclude it unless `?includeArchived=1`). Delete is
  irreversible in the UI: the record rows go (a Project cascades its Sessions +
  Runs, a Session its Runs) and the Project Workspace is MOVED to a sibling
  `.recycle/<id>-<ts>/` under `PROJECT_ROOT` via `Workspace.recycle?()` — bytes
  recoverable by hand, no restore endpoint. The bootstrap `project-default` row
  (or `PROJECT_ID`) cannot be renamed/archived/deleted (403); `GET /api/projects`
  returns its id so the UI locks those actions. Deleting a Project also releases
  its cached `Environment` (`EnvironmentProvider.release?()`).
- Worktrees ride the same lifecycle (docs/adr/0025): `GET /api/worktrees?projectId=`
  lists a Project's worktrees (each row decorated with on-disk state); a fresh
  workspace directory is skipped instead of being mistaken for a missing Git,
  and a genuinely unavailable Git still returns the rows with
  `gitAvailable: false`, while create/delete answer 503.
  `POST /api/worktrees` creates one (`{ projectId, name, branch?, base? }`; the
  first create lazily runs `git init` + an initial commit, so a list never
  touches the disk), and `POST /api/worktrees/:id/{rename,archive,unarchive,delete}`
  manage them — `main` is protected (403) from rename/archive/delete. A
  Worktree's path is DERIVED, never stored: `main` IS the Project root, else
  `.worktrees/<id>/` under it. Archive releases that worktree's cached
  environment (keeping the directory); delete releases the child, removes the
  checkout, deletes its branch (so the same name is creatable again), recycles
  any remainder, then cascades its Sessions + Runs. Sessions carry a `worktreeId`
  (`POST /api/projects/:id/sessions` accepts it, validated against the record;
  `GET .../sessions?worktreeId=` filters; a legacy row with none reads as `main`).
- Workspace file access is **opt-in** and served per **(Project, Worktree)**:
  `PROJECT_ROOT` is the host-side parent of every project directory — a Project's
  workspace root is `<PROJECT_ROOT>/<projectId>/` (its `main` worktree), and a
  linked worktree is `<PROJECT_ROOT>/<projectId>/.worktrees/<id>/`; the derived
  path comes from `localWorkspace(env, projectId, worktreeId)`, never the record
  (docs/adr/0006, 0025). `PROJECT_AGENT_ROOT` is the agent-side counterpart, and
  `WORKSPACE_MAX_INLINE_BYTES` is the inline cap; unset `PROJECT_ROOT` means
  `NullWorkspace` and no file surface. Routes live on the SAME service and ask
  `ProjectScopes` (`services/transport-service/src/project-scope.ts`) for the
  request's scope — the Principal, the Project (the query's `projectId`, else the
  query's `project` (the older spelling), else the body's, else `project-default`),
  the Worktree (the `worktreeId` claim, else `main`), and that scope's
  `Environment` — so no route spells the Project claim its own
  way and no route body repeats the preamble: `GET
  /api/workspace/{entries,stat,file}`, plus `GET
  /api/workspace/interactions?path=&molql=` and `POST
  /api/workspace/measurements` (molstar-computed non-covalent interactions and
  measurements; see the MolQL section). `file` streams inline up
  to the cap (413 over it) and `?download=1` streams any size; a missing path is
  404, a traversal/absolute path 400, no workspace 503. Uploads are `POST
  /api/workspace/upload?path=` with a **raw** body
  (`application/octet-stream`, one file per request — no multipart parser);
  `maxUploadBytes` (`WORKSPACE_MAX_UPLOAD_BYTES`, default 100 MB) answers 413 and
  `QuotaPolicy` answers 507 on the declared size. Upload caps: also
  `WORKSPACE_QUOTA_BYTES` (default 2 GB).
  The web app reaches these through `app/api/workspace/[...path]` (a streaming
  proxy, same buffering rule as the transport route). Client-side, workspace
  access is `@gps/transport-client`'s `useWorkspaceBrowser` /
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
  raw 503. The composer `@` picker is `useWorkspaceMentions`; it BROWSEs the
  workspace one directory at a time (`{ withParent: true }` prepends a synthetic
  `..`), so picking a directory navigates into it (breadcrumb + `..` row) and
  only a file inserts assistant-ui directive text (`:file[label]{name=id}` /
  `:directory[...]`) which the service lifts into a workspace `AttachmentRef`
  (`parseWorkspaceMentions`) — a directory stays a reference, never expanded.
  The composer input is assistant-ui's Lexical editor (`LexicalComposerInput`,
  `@assistant-ui/react-lexical`, docs/adr/0023), so a mention renders inline as
  an icon+name chip while the wire still carries that directive text; the `@`
  trigger is an Action (not a Directive), leaving the trigger's single
  selection-override slot to the directory-navigation override.
  The Project Workspace also carries the scheduled-run files under
  `.gps/cron/` (`<id>.md` + `<id>.log.md`), which the file tree lists
  like any other path; `apps/web/app/api/cron` proxies the `/api/cron*` surface to
  the service (docs/adr/0017).
- `npm run dev -w @gps/transport-openclaw-example` — the example app: Vite (5173, proxies `/api`) + the openclaw adapter behind `@gps/transport-service` (3200). Needs `examples/transport-openclaw-example/.env` (see its `.env.example`) and a live gateway, and `npm run build` first (imports deps from dist). Dev-only — intentionally NOT in the root build gate; its `npm run test` drives the same wiring against a scripted gateway (no live gateway needed).
- `npm run dev -w @gps/transport-dsh-example` — the same shape over the dsh adapter: Vite (5173) + `@gps/transport-service` (3300); the adapter spawns `dsh --profile sdk` locally (needs `examples/transport-dsh-example/.env` with `DEEPSEEK_API_KEY`, the model route `HARNESS_PROVIDER`/`HARNESS_MODEL`, and that route's `apiKeyEnv` name — `server.ts` promotes those two `HARNESS_*` names to the launch-only `DSH_PROVIDER`/`DSH_MODEL` before the adapter reads it, because the harness child runs with that folder as cwd and the dsh CLI reads that same `.env` and hard-refuses any `DSH_*` key in it; the route itself — endpoint/models — is declared harness-side in `<harness home>/settings.yaml`, and the default example route is the LAN ollama `ollama-local`/`qwen3.8:latest`; defaults when `HARNESS_*` is unset: profile `sdk`, home `~/.dsh`, workspace = the example dir, transcript mirror under the service tmp dir, adapter provider/model `deepseek-official`/`deepseek-v4-flash` — override `DSH_HOME`/`DSH_TRANSCRIPT_DIR`/`DSH_MODEL`… via exported env). Its `npm run test` drives the wiring against a scripted turn client (no dsh process needed).
- `npm run test:e2e -w @gps/web` — the web app's regression suite, all of it in one command: the panel/history tests mock the transport + record + workspace HTTP surface and assert the re-render invariants, `test/scope-restore.test.mjs` asserts that a load resumes the remembered scope and never probes an id the record does not list (docs/adr/0009), and `test/scope-memory.test.mjs` is the browserless resolution table (no Chromium needed; it imports `lib/scope-memory.ts` through Node's type stripping). The browser ones run their own `next dev` with a PRIVATE build dir (`NEXT_DIST_DIR=.next-test`, read by `next.config.mjs`) so the suite can run while a developer's own `npm run dev` is up — two dev servers on one `.next` corrupt it. Next rewrites `next-env.d.ts`/`tsconfig.json` to match whichever dist dir ran last, so a suite run may leave those generated lines dirty; the next `npm run dev`/`next build` flips them back. They need a Chromium (auto-detected; they SKIP without one) and `npm run build -w @gps/transport-client` first. Dev-only — NOT part of the root `npm test`.
- `npm run build` — build record → transport → workspace → cron → hpc → contract-tests → transport-client → molstar-viewer → transport-openclaw → transport-dsh → transport-service, then
  `npm run typecheck:tests`; this is the real type gate. Each package's own
  `tsconfig.json` includes only `src/**` (so `tsc -b` emits just the package), so
  the TESTS are checked by one separate program, `tsconfig.tests.json` over
  `packages/*/test` + `services/*/test`. It runs LAST because
  `@gps/*` resolves to the built `dist` types. Outside the gate:
  `apps/web/test/*.mjs` (plain JS), the dev-only `examples/*`, and the two
  `packages/plugins/molql-tool-*` agent-side packages (built/deployed
  independently; `packages/plugins`/`packages/skills` are excluded from the root
  workspaces).
- `npm run typecheck` — **known-broken**: fails in transport-service with pre-existing TS6310 (composite refs + `--noEmit`). Other workspaces pass; use `npm run build` for the service.
- `npm run smoke:adapter` — connect a real openclaw adapter to a live gateway and drive one `chat.send` (sends a real message to `OPENCLAW_DEFAULT_SESSION` unless `SMOKE_SESSION` overrides it). Needs `npm run build` first.
- `npm run smoke:replay -- <file>` — fold recorded SSE frames through the client decoder/accumulator (verifies a stream terminates with `[DONE]` and only uses `set` ops).
- No test suite exists anywhere yet (root `npm run test` is a no-op). — **stale**: transport, transport-openclaw, transport-client, transport-dsh, transport-service, workspace and both example workspaces have suites (root `npm run test` runs them; 113+ green as of Phase 0).

## Transport wire contract (frontend ↔ service)

- **Every transport request is `(projectId, worktreeId)`-scoped.** The client
  carries `projectId`, the Worktree its scope names (`worktreeId`) and the Session
  (as `threadId`); the service reads them from the **query string
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
  claim (the client carries it from `TransportApiProvider`, and the web's
  `/api/transport/commands` hop relays the query), so it is the Project's own
  adapter's catalog. The `worktreeId` claim defaults to `main` and an unknown id
  is a 404, never auto-created, so a request scopes to `(projectId, worktreeId)`
  — the full client-side claim lands in the workbench plan.
- **JSON bodies are capped at 16 MiB** (`TRANSPORT_MAX_BODY_BYTES` overrides,
  service env). The transport POST carries the client's WHOLE claimed
  transcript in `state` (assistant-ui round-trips `agentStateRef.current` on
  every send and probe), so it grows with the conversation — Fastify's default
  1 MiB `bodyLimit` answered `413 FST_ERR_CTP_BODY_TOO_LARGE` BEFORE the
  handler ran, wedging the thread (every send and the mount probe failed the
  same way). Streaming bodies (the octet-stream upload parser) never pass
  through this limit; they keep their own caps. Guard:
  `services/transport-service/test/body-limit.test.ts`.
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
  `@gps/transport-client`), which POSTs the empty-command request on
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
  WORKTREE's workspace, derived at init from the workspace seam
  (`Workspace.toAgentPath("")`, i.e. the same directory the Files panel lists).
  That holds because the service provisions one adapter — and so one harness
  child — per `(Project, Worktree)`, each initialized with its own worktree's
  workspace (docs/adr/0008, 0025); one shared adapter could only ever serve the
  default Project. Only a `NullWorkspace` deployment (no `PROJECT_ROOT`) falls back to
  `DSH_WORKSPACE`/`process.cwd()`, because its empty answer is not a
  launchable cwd. Reading the raw `DSH_WORKSPACE` env var here is a foot-gun:
  the dev script points it at the Project PARENT, so the agent worked beside
  `<PROJECT_ROOT>/<projectId>/` while the panel listed that (empty) subdir;
  (2) events arrive per COMMITTED log event, not per token — each step's
  `assistant/message` becomes a whole-message final `set`, but a live path
  (`GET /assistant-stream` on the bridge socket, docs/adr/0022) streams the
  step's `text-delta` / `reasoning-delta` frames as small `stream-text` /
  `stream-reasoning` ops while the step runs and streams a tool call's
  `tool-call-delta` frames as part growth (`add-part` then `update-message`), so
  replies render progressively and the committed `set` finalizes the row; (3) the SDK wire has no
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
  hanging on an open stream (dsh has no remote settles to coalesce); (6) the
  wire has NO command plane (three methods, no server→client requests): the
  adapter answers its own two (`/status`, `/new` — work with no child at all)
  and resolves every other name through the harness's OWN registry — executed
  over the command bridge when this session HAS an agent, and driven as the
  session's FIRST PROMPT when it has none (docs/adr/0011). The bridge is a
  dependency-free cordis plugin the adapter ships into the child over a
  per-launch profile patch, speaking `GET /commands`/`POST /execute`/`POST
  /interrupt` on a private socket (local names win, an unknown `/name` is
  answered); the plugin
  ALSO holds an `agent/pre-step` listener, which is what makes the cold case
  safe — a `/`-line prompt is run by the registry and its step REJECTED, so the
  turn ends `blocked` and the model never sees it (the reply is the harness's own
  `command/done`; a line the registry does not resolve gets the `Unknown command
  …` row). That is why a command works on a session that has never prompted: the
  prompt IS what creates the agent, so plan mode / a goal is in force before the
  first model request. The registry is agent-scoped and an agent needs a prompt,
  so a COLD runtime has nothing to enumerate: the menu then serves the curated
  list of the pinned profile's own commands instead of looking empty. A batch
  that drives no model turn (the mount probe, or commands only) still never
  STARTS the child for a catalog read: the menu and `/status` work where the
  harness could not launch, while a user-issued harness command does boot it.
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
  no approval surface (`RuntimeAdapter.approve` is optional). **Abort is a REAL
  mid-turn cancel**, not just a client-stream teardown: the kit's
  `SessionRuntime.abort` ends the client flow AND calls the behavior's optional
  `cancel(sessionKey, runId)`. openclaw issues `chat.abort {sessionKey, runId}`;
  dsh — whose SDK wire has no cancel method — asks the child bridge (`POST
  /interrupt`) to run the harness's own `agent.cancel({kind:"user"},
  {keepInbox:true})`, so the running turn stops and a follow-up prompt is not
  queued behind it. The workbench stop button drives this through the `apps/web`
  abort proxy; `useTransport`'s `onCancel` posts it and drops the wire state to
  `idle` (an aborted run sends no terminal frame, and the watch import is gated
  on that status). The kit ALSO forces the canonical status out of `running`
  and notifies watchers in `abort()`, so a runtime whose cancel is unavailable
  or slow can never leave the UI wedged at "running"; `useTransport` ignores a
  still-`running` watch snapshot until the service converges, so the two cannot
  flip-flop.

## Molecular-structure preview and the `molql` tool

- **The structure preview is a renderer, not a package change.** The workspace
  center pane (`components/studio/file-preview-pane.tsx`) detects a structure
  file BY NAME (`kindFor` → `"structure"`; the workspace mime map does not know
  PDB/CIF, so they arrive as `application/octet-stream`) and lazily mounts
  `renderers/StructureRenderer.tsx` (`dynamic(..., {ssr:false})`, since Mol* is
  browser-only). It loads the file through the workspace URL and embeds Mol* via
  `PluginUIContext` (`@gps/molstar-viewer`). The Mol* canvas clears to
  TRANSPARENT (`packages/molstar-viewer/src/viewer.ts`) and the renderer paints
  `bg-background` (`renderers/structure-theme.css` clears the light skin's own
  opaque `.msp-plugin`/`.msp-viewport` backgrounds), so the structure view
  follows the light/dark appearance AND every color theme (docs/adr/0027).
  `packages/workspace` is untouched.
- **`@gps/molstar-viewer` is the browser boundary.** `applyMolqlSelection`
  compiles the expression with `Script.toLoci({expression, language:'mol-script'}, structure)`
  and, by default, applies a PERSISTENT selection (`interactivity.lociSelects.selectOnly`)
  plus a camera focus (`managers.camera.focusLoci`); `mode:"highlight"` uses the
  transient `lociHighlights.highlightOnly`. `molstar` is pinned exactly `5.9.0`
  and its skin is imported by the app (which owns `sass`), so the package stays a
  pure `tsc` build and its `./formats` + `./directive` entries stay
  molstar-runtime-free (and thus Node-testable).
- **The agent drives it through one tool, `molql`**, registered by BOTH plugins
  (`packages/plugins/molql-tool-dsh`, `packages/plugins/molql-tool-openclaw`).
  The tool output is the JSON contract
  `{ type:"molql-selection", molql, description?, focus?, mode? }`; the model does
  the natural-language translation, the tool only structures/forwards it. Syntax
  validation is FRONTEND-only (the browser has the structure); the server-side
  tool does not import Mol*.
- **An operation targets the file the user is VIEWING — never a path the model
  guessed from history.** Several structure tabs can be open at once, so the
  viewer registry is keyed BY PATH (`setMolqlViewer(path, viewer)` /
  `getMolqlViewer(path)`), and `apps/web/store/studio-store.ts` derives
  `activeStructurePath` (the active tab iff it is a structure file). `molql`
  carries no path, so its handler applies to `getMolqlViewer(activeStructurePath)`;
  when the viewed file is not a structure it raises a `sonner` toast instead of
  silently doing nothing (or drawing on a hidden tab). The `molql` TOOL also
  consults `GET /api/transport/active-structure` (the service's stored view
  context) before returning, and FAILS when the service reports no structure
  file is open — so the agent asks the user instead of claiming a selection it
  cannot apply (a check that cannot run is best-effort and passes through). The
  `measurements`/`computeInteraction` tools DO need a file, resolved in this
  order: (1) an explicit path/mention the user gave, (2) the file the client
  reports as currently open, (3) neither → the route answers 400 and the agent
  asks the user. The client reports the open structure on each send as
  `body.view.activeStructure` — service-only UI context, NEVER part of the model
  prompt; the service stores the latest (process-wide, single-user) and
  `/api/workspace/{interactions,measurements}` fall back to it when `path` is
  omitted. A `measurements` result carries its `path` and the viewer draws it on
  THAT file (revealing its tab), so file A's numbers can never land on file B.
- **The wire already carries the result.** Both adapters merge a tool's output
  into its `tool-call` part's `result` string, so no adapter/service change is
  needed. The bridge (`components/assistant-ui/frontend-bridge.tsx`, mounted in
  `session-view.tsx`) registers a tool-call renderer for `molql`, dispatches each
  completed call exactly once (keyed by `toolCallId`), and hands the raw result to
  the app-local handler (`lib/frontend-actions/molql.ts`), which dynamically
  imports `molstar-viewer` and applies it. The chat bundle never imports molstar.
  An ERRORED tool call (e.g. `molql` reporting no open structure) is skipped, so
  the agent's own question is not duplicated by a frontend toast.
- **The skill is the manual, the tool is the channel.** `packages/skills/molql`
  is the single source (cheat-sheet → tool description; full
  `references/molql-syntax.md` → embedded skill). Each plugin's
  `scripts/sync-skill.mjs` copies it into its own `skill/` at build time; the
  plugin packages are agent-side deployables and are NOT in the root build.
- **The reverse direction (viewer → composer) is a click, gated on Mol*'s
  selection mode.** `MolqlViewer` subscribes to
  `plugin.behaviors.interaction.click`, and ONLY while `plugin.selectionMode` is
  on resolves the clicked loci and calls `onResidueClick` (`null` for an empty
  click, which clears Mol*'s selection). Resolution lives in `resolve.ts` (molstar
  model only, Node-tested): `StructureElement.Loci` → an atom when the picking
  level (`plugin.managers.interactivity.props.granularity`) is the element level
  ("Atom/Coarse Element") and a residue otherwise; `Bond.Loci` → its two endpoint
  atoms; `Interactions.Loci` (a dashed non-covalent interaction) → the two
  representative endpoint atoms plus Mol*'s interaction-type label
  (`Interactions.locationLabel`).
  `MolqlViewerPanel` forwards it; `StructureRenderer` formats
  `@<project>/<workspace path>/<molql>` (`selection.ts`'s `formatResidueMolql` /
  `formatAtomMolql` / `formatBondMolql` / `formatInteractionMolql` /
  `formatStructureMention` / `molqlTargetKey` — pure, Node-tested), appending a
  ` #<interaction type>` suffix for interactions (metadata; the agent-side plugins
  strip it in `parseSelectionItem` / the `molql` and `computeInteraction` tools),
  and toggles it in the composer through `ComposerInsertProvider` (an app-local
  context seam modelled on `WorkspaceOpenProvider`, since the center preview and
  the left `Thread` are siblings), then reveals the conversation pane via the
  store's `revealLeftView`. A second click on the same target REMOVES the mention
  (keyed by `molqlTargetKey`), matching Mol*'s default `clickToggle` action; an
  empty click removes them all. The visible selection is Mol*'s own
  selection-mode behavior — the app adds no second selection. The mention is plain
  text (not a `:file` directive), so the service does not lift it into an
  `AttachmentRef`.
- **`computeInteraction` is the one place the browser is NOT enough.** The agent
  can only receive the computed result if the computation happens where its tool
  runs, and molstar's interaction module is pure computation (no WebGL), so the
  service computes it: molstar's CommonJS build is loaded lazily through
  `createRequire` in `services/transport-service/src/interactions.ts`, which
  parses the workspace file, compiles the MolQL selection, runs
  `computeInteractions` (molstar's default providers: hydrogen-bonds, pi-stacking,
  cation-pi, halogen-bonds, metal-coordination) and returns the contacts touching
  the selection as a Markdown table. The route is `GET
  /api/workspace/interactions?project=&path=&molql=` (same workspace preamble;
  404/400/503 as the other workspace routes; `molstar` is a service dependency).
  Both agent-side plugins register the same `computeInteraction` tool, which
  fetches that route (`GPS_SERVICE_URL`, default
  `http://127.0.0.1:3001`) from the `@<project>/<path>/<molql>` mention. There is
  deliberately NO browser→agent tool-result channel: `TransportCommand` declares
  `add-tool-result` but no adapter implements it, and openclaw's chat protocol has
  no client tool result — so browser-computed data could not reach the model.
- **`measurements` is the second service-computed tool, and the one result that
  feeds BOTH the agent and the viewer.** The agent measures an ordered selection
  set: `kind` ∈ `label`/`distance`/`angle`/`dihedral`/`orientation`/`plane`,
  with `selections[]` of MolQL expressions or full `@project/path/molql`
  mentions. The plugin parses each item deterministically (`parseSelectionItem`:
  a mention yields project/path/molql; anything else is bare MolQL, the model's
  verb→MolQL translation), so the model only has to ORDER the click mentions.
  `services/transport-service/src/measurements.ts` computes the value with the
  SAME molstar formulas the viewer draws (`Loci.getCenter` +
  `Vec3.distance`/`angle`/`dihedralAngle`; `StructureElement.Loci.
  getPrincipalAxesMany` for orientation/plane), behind `POST
  /api/workspace/measurements` (JSON body
  `{project,path,kind,selections}`, same workspace preamble; the headless
  molstar loader is shared with `interactions.ts` in `structure.ts`). The single
  tool result carries both the `text`/`values` (for the model) and the display
  directive, which the frontend action (`lib/frontend-actions/measurements.ts`)
  applies to the active viewer via `plugin.managers.structure.measurement`.
  Arity and empty selections fail loudly (400 naming the bad selection); the
  model does the natural-language translation, molstar validates it.

## MSA (sequence alignment) preview

- **Name-based kind, self-fetch, four-state routing.** `kindFor` recognizes `"msa"` by
  name (`.clustal/.clustal.om/.sto/.stockholm/.fasta/.fa/.faa/.fna/.aln/.a3m/.result`, and
  names ending in `*_result`) and `renderers/MsaRenderer.tsx` (dynamic `ssr:false`,
  like StructureRenderer) fetches its OWN bytes and decodes UTF-8 — deliberately NOT
  through `useWorkspaceFile`, which would classify an `application/octet-stream`
  answer as binary (the two must-stay-in-sync mime lists stay untouched). It routes
  by parse result: aligned → `MsaGrid`, unaligned → `UnalignedList`, mmseqs →
  `MsaResultTable`; a parse failure falls back to plain text — never a blank pane.
  **A 413 (the inline cap) is retried on the streaming `download=1` variant** and only
  then refused past a 64 MB viewer ceiling: a real a3m passes the 8 MiB inline cap while
  the viewer legitimately wants the whole alignment (the request is aborted on unmount).
  The plain-text degradation is a COST model, not a cell count — plain only above 20 000
  columns or 20 000 000 cells — because rows are virtualized and same-class characters are
  grouped into runs, so a 14 633 × 427 ColabFold MSA (~500 ms of one-time statistics) is a
  perfectly good grid; the statistics pass is skipped entirely in plain mode.
- **a3m is an alignment whose lowercase letters are insertions.** `parseAlignment` treats a
  ragged FASTA as a3m when at least one record carries lowercase and removing it makes every
  record the same length (the file came in at 52 distinct raw lengths and exactly one after
  stripping); the aligned result reports `insertionsStripped`, and the grid says so instead
  of silently showing something other than the file ("Raw text" shows it as written). An
  already-uniform file is left alone — its lowercase is not read as insertion. NUL and
  other control bytes are stripped before parsing, so a stray `\0` from a generator
  cannot count as a residue and defeat the length check.
  A repeated `>` header is a distinct record, not interleaving: real ColabFold/UniRef
  a3m files repeat a UniRef id, so `MsaSequence.name` is not unique; its `id` (the
  record's position) is the grid's row identity (selection/hover/React keys), and a
  mention keeps the name as written in the file.
- **The package is the boundary (zero molstar).** MSA is a text grid, not a 3D
  scene, and Mol\* 5.9.0 ships no MSA component (verified against the installed
  tree) — so `@gps/msa-viewer` owns the parsing/stats/mention/grid math
  (pure, Node-tested: `npm run test -w @gps/msa-viewer`) and the React
  views are thin over it, the same precedent as `@gps/molstar-viewer`'s
  `react/` folder. `isTextEditable` excludes `"msa"` (no source editor — the
  renderer's "Raw text" toggle is that affordance).
- **Mentions are plain text over the existing seam.** Double-click (or the
  "insert" button) toggles `@<project>/<path>/<seqName>@<col>[-<col>]` in the
  composer through `ComposerInsertProvider`, keyed
  `<project>/<path>::<seqName>@<start>-<end>` — exactly the structure-mention
  `molqlTargetKey` rule — then reveals the
  conversation pane. No new directive, no service route, no agent-side plugin:
  the agent reads the alignment TEXT from its own cwd; if tools are ever added,
  `parseMsaMention` is the parse rule they reuse.

## Architecture rules

- **Record is authoritative.** Generative Protein System owns the research record — in v1
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
  runtimes DYNAMICALLY (`GPS_RUNTIME_MODULES` → each module's `runtimePlugins`),
  and the DEFAULT list is data in the service's `package.json`, so adding a
  runtime touches no core *code* — and the private enterprise
  module is loaded the same way (`GPS_ENTERPRISE_MODULE`). See
  docs/design/implementation-plan.md §5 for the CI invariants. The
  `@gps/contract-tests` package publishes the executable form of
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
  constants. The **workspace and the runtime are `(projectId, worktreeId)`-scoped**:
  the service acquires that scope's `Environment` — one workspace AND one adapter
  per `(Project, Worktree)`, each initialized with that worktree's workspace
  (docs/adr/0008, 0025), which is what makes the dsh child's cwd the worktree
  directory — and only then maps the claimed `threadId` through the
  adapter's `resolveSessionKey`. The adapter persists `Run`s through a narrowed
  view of the SAME `RecordStore` the service reads identity from (`records` on
  `Backend`; both `localBackend` and the `{ adapters }` compat path share one
  instance).
- **The remembered scope is chrome state, and it is only trusted after the record
  confirms it** (docs/adr/0009). `apps/web/lib/scope-memory.ts` keeps
  `{version, lastProjectId, worktrees, sessions}` per browser in one versioned
  `localStorage` blob (`worktrees` keyed per Project; `sessions` per
  `(projectId, worktreeId)`); `setScope` on `studio-store.ts` is the ONLY way the
  scope changes, moving the store, the memory and the URL together. Resolution is
  three levels — Project, then Worktree, then Session: the URL's claim when the
  record lists it, else the remembered Project, else the first Project; the URL's
  Worktree when that Project's list holds it, else the remembered one, else
  `main`; then a Session from that `(Project, Worktree)` pair's list (else its
  newest). It runs BEFORE the shell
  renders: an unvalidated Session must never mount, because the mount probe
  (`resolveOrCreateSession`) MINTS the Project and Session rows for an unknown key
  rather than refusing it. Only an authoritative "no" prunes — a fetch failure
  leaves the memory alone. The URL is MIRRORED with `history.replaceState`, never
  navigated: a router navigation across route segments remounts the runtime owner
  (and a mid-run switch then hits the one-in-flight-run 409).
- **Keep the transport package React-free.** The shared client package
  (`@gps/transport-client`) owns the assistant-ui boundary as ONE
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
- **Open file tabs stay MOUNTED; only the active one is shown.**
  `FilePreviewPane` (`apps/web/components/studio/file-preview-pane.tsx`) renders
  EVERY tab's `Preview` and hides the inactive ones with `invisible`
  (`visibility:hidden`) + `inert` + `aria-hidden` — never `display:none`/`hidden`,
  which drops the layout box and can reset a scroll container's `scrollTop`. That
  is what preserves per-tab state (scroll position, and any component state a
  future renderer holds) across a tab switch, and why each tab fetches its file
  once instead of on every switch. Scope: same Session only — a Session switch
  remounts the shell (`StudioHost` keys `SessionView` by
  `projectId/worktreeId/sessionId`), and a Project or Worktree switch clears
  `tabs`. The regression
  guard is `apps/web/test/tab-state.test.mjs`. **A renderer inside a tab must
  never assert its own `visibility`** (e.g. an `<img>` flipping
  `hidden → visible` on load) — in CSS a child's `visibility:visible`
  OVERRIDES the ancestor's `hidden`, so the element resurrects inside the
  hidden pane and covers the active tab; a loading-state toggle belongs on an
  overlay over the content, never on the content element itself (pinned by the
  image test in `tab-state.test.mjs`).
- **PDF, image and structure previews are by file NAME, and the viewer fetches
  its own bytes.** `apps/web/components/studio/file-utils.ts` adds
  `pdf`/`image`/`structure` to `FileKind` and decides them from the name
  (images: png/jpg/jpeg/gif/webp/bmp/svg), because the workspace service serves
  `.pdf` as `application/pdf`, images as `image/*`, and every structure format
  (`.pdb/.cif/.mmcif/.mol/.mol2/.bcif` + `.gz`) as
  `application/octet-stream` — a MIME sniff cannot tell them apart. `Preview`
  routes those kinds to `renderers/PdfRenderer.tsx` (EmbedPDF; external webfonts
  disabled), `renderers/ImageRenderer.tsx` (a plain `<img>`; decode failure is a
  friendly "use download" line, and images have NO source view —
  `isTextEditable` excludes them) and `renderers/StructureRenderer.tsx` (Mol*,
  browser-only via `next/dynamic(... ssr:false)`), handing them the inline
  `workspaceFileUrl(api, path, { project })`; ONLY text kinds call
  `useWorkspaceFile`, so a viewer never downloads the file twice. The Mol* port
  lives in `renderers/molecule-viewer.ts`. The routing is pinned by
  `apps/web/test/file-kinds.test.mjs`. Common text formats preview inline as
  text — the "which mime counts as text?" gate lives in TWO places that must
  stay in sync: `isTextMime`/`mimeFor` in `packages/workspace/src/mime.ts`
  (server answer mime; `.env`/`.env.*` are text by name) and `looksTextual` in
  `packages/transport-client/src/workspace.tsx` (client read decision);
  `file-utils.ts`'s `languageFor` picks the shiki grammar (yaml/xml/toml/ini/
  properties/sql/csv/html, preloaded in `renderers/highlight.ts`) and returns
  `undefined` for anything unknown so the pane renders PLAIN text instead of a
  wrong grammar (a `.txt` must not be JS-highlighted). **The Mol* init/dispose is async and
  race-guarded** (`MolstarViewer.disposed`): dev StrictMode double-invokes the
  effect, and a dispose that runs before `createPluginUI` resolves would
  otherwise leave the orphaned plugin's blank canvas stacked above the loaded
  one — the "plugin loads but the structure is blank" symptom.
- **Adapters compose one shared run lifecycle** in `@gps/transport`
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
  destroys the upstream socket. Chrome does NOT close its pooled socket on a
  fetch abort, so the relay must tie the upstream's lifetime to the client
  itself: the WATCH route is the one hop that passes `request.signal` through
  (`hop.signal` → `requestStream`), and without it every abandoned watch leaks
  one upstream socket per scope switch. A run or an upload deliberately does
  NOT do that — those must keep going after the client goes. Short JSON hops
  pay nothing for the same relay —
  one policy, no "which one does this route use?".
  `runtime`/`dynamic` stay literal in each route file (Next must statically
  analyze route segment config, so it cannot be re-exported). Each route keeps
  only what is genuinely per-hop: the upstream path + query (the watch is the one
  hop that WHITELISTS its query instead of relaying it) and the request body.
  **No hop rewrites a failure** (docs/adr/0021): the transport-service logs an
  adapter throw and rethrows, the proxy relays it, and the CLIENT surface owns
  the decision — `useSubagents` / `useCronTasks` / `useSessionMetrics` keep
  their last good value, `useRuntimeCommands` degrades to an empty catalog, and
  the Skills tab shows an error with a Retry. A runtime that lacks an optional
  surface is NOT a failure: the service answers a successful empty payload
  (`subagents`, `commands`) or `available:false` (`skills`).
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
- `@gps/record` exports `createInMemoryRecordStore()` (and the JSONL
  store the service uses by default). With `Artifact` out of v1 the adapter seam
  `RecordStoreLike` (and the kit's `RunSink`) is the single method `addRun`, so
  the authoritative `RecordStore` satisfies it directly — but the service still
  wires it explicitly rather than by `as any`, and the ONE `RecordStore` instance
  is deliberately shared by the adapter's sink and the service's
  `records`/project-session directory, so Runs and Sessions land together.
- All ten `apps/web` proxies (`app/api/transport/route.ts`, `transport/commands`,
  `transport/abort`, `transport/subagents`, `transport/watch`, `workspace/[...path]`,
  `projects/[[...path]]`, `cron/[[...path]]`, `hpc/[[...path]]`,
  `mcp/[[...path]]`, `worktrees/[[...path]]`) forward the
  caller's `Authorization` header upstream — one line in
  `lib/service-proxy.ts` (`forwardedAuth`), so a new hop cannot forget it.
  Single-user installs send none (no login); in hosted mode the enterprise
  `PrincipalResolver` authenticates the bearer, so a proxy that swallows the
  header breaks auth silently. `projects` is the record surface
  (`/api/projects*`) the Projects pane reads, and it is what keeps the browser
  same-origin on port 3000.
