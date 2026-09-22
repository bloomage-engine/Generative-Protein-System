# HPC integration — Slurm and bare Linux over SSH (design spec)

Frozen design for the HPC Compute feature: docs/adr/0024 owns the decisions,
`CONTEXT.md` §HPC Compute owns the vocabulary. This document is the
implementation-level contract: schemas, routes, flows, surfaces, tests.

## 1 Shape

Four roles, one line each:

- **The service is the only SSH client.** `services/transport-service/src/hpc/`
  owns submit, cancel, logs, staging, probe, and reconciliation — by spawning
  the system `ssh`/`scp` binaries. Nothing else in the product touches the
  network toward a cluster.
- **The `ComputeJob` ledger is the read model.** The panel and the agent tools
  read record rows; a GET never queries the cluster. Only the poller turns SSH
  into state.
- **The dsh child plugin is a channel.** A fifth per-launch patch ships
  `hpc-plugin.ts`: five tools + one `systemPrompt` section, all of which fetch
  the service (`computeInteraction` pattern, docs/adr/0024).
- **The workbench owns configuration.** Settings → HPC tab (endpoints +
  Project binding); right panel → Jobs section; double-click → synthetic
  `hpc:<jobId>` detail/log tab.

```
dsh child (hpc-plugin tools) ──fetch──▶ /api/hpc/* ──▶ spawn ssh ──▶ cluster
                                          │   ▲
                        ComputeJob rows ──┤   │ reconcile (squeue/sacct/pid)
                                          ▼   │
              RecordStore (JSONL)        HpcJobPoller (15 s tick)
```

## 2 Settings contract — the `hpc` section

`packages/transport/src/settings.ts` (type-only contract, re-exported through
`./seams` — the explicit export list and `test/seams.test.ts` must be updated
together):

```ts
interface HpcSettings { endpoints: HpcEndpoint[] }
interface HpcEndpoint {
  id: string;                 // /^[a-z0-9][a-z0-9-]{0,63}$/ (the cron id grammar)
  name: string;               // display label
  kind: "slurm" | "linux";
  host: string;               // host, IP, or ~/.ssh/config alias
  user?: string;              // absent = ssh decides (config / local user)
  port?: number;              // absent = 22
  keyPath?: string;           // a PATH, not secret material — shown in the view
  defaultPartition?: string;  // slurm only
  defaultTime?: string;       // "HH:MM:SS" | "MM" — a submit-time default
  maxConcurrentJobs?: number; // absent/0 = unlimited (see §7 guard)
}
```

- `RuntimeSettings` gains `hpc?: HpcSettings`; `RuntimeSettingsPatch` gains
  `hpc?: { endpoints?: HpcEndpoint[] | null }` — the list replaces wholesale;
  `""` on a field deletes it (docs/adr/0015 semantics).
- `parseSettingsPatch` gains an `hpc` branch: id grammar, `kind` enum, port
  1–65535, non-empty `host`; a violation is a 400.
- `viewOf` passes endpoints through (no secret material lives here — the key
  is referenced by path).
- **Hot-apply, deliberately:** unlike the model route, the HPC section is NOT
  folded into env at boot. Routes and the poller re-read the settings file per
  request/tick, so editing an endpoint takes effect without a restart.
  (docs/adr/0015's restart rule is about the model route; this is noted in the
  ADR's surface, not a new setting path.)
- PUT remains manager-gated (`principal.local || roles.includes("manager")`).

## 3 Project HPC Binding — the workspace file

`.science-studio/hpc.md` inside the Project Workspace (the `.science-studio/`
namespace, shared with cron). House-style frontmatter codec in `packages/hpc`:

```
---
endpoint: "cluster-a"
partition: "gpu"          # optional override of the endpoint default
workDir: "~/ss-proj42"    # optional Remote Work Dir override
defaultTime: "4:00:00"    # optional
---
Freeform body: cluster-use notes the Researcher keeps for the Agent.
```

- `parseHpcBinding(text) → { binding } | { error }`, `serializeHpcBinding`.
  Malformed → the binding GET surfaces `{error}`; never fatal.
- **Reads** happen server-side only (submit/cancel/staging resolve the binding
  through `ProjectScopes.withWorkspace`). The agent sees the file in its own
  cwd; it has no binding-write tool — UI-only (§10).
- No binding → submit answers 400 `project not bound to an HPC endpoint`; a
  binding naming a deleted endpoint answers 400 `unknown endpoint "<id>"`.
- Defaults precedence at submit: binding field > endpoint field > none.

## 4 `packages/hpc` (new root workspace)

Pure, zero-dependency, in the root build chain after `cron`; tests under
`packages/hpc/test` (already covered by `tsconfig.tests.json`'s
`packages/*/test` glob). Exports:

- `binding.ts` — the §3 codec + path constant `HPC_BINDING_PATH`.
- `slurm-state.ts` — map squeue/sacct states to `ComputeJobState`:
  `P/PD/CF→pending`, `R/CG/S→running`, `CD/R→(post-run via sacct)→completed`,
  `F/TO→failed`, `CA→cancelled`, anything unmapped→`unknown`.
- `job-layout.ts` — Remote Work Dir conventions:
  `defaultWorkDir(projectId) = ~/science-studio/<projectId>`, and per-job dir
  `<workDir>/.ss-jobs/<cjobId>/` with fixed names `script.sh`, `stdout`,
  `stderr`, `pid`, `rc`. All names derive from server-generated ids, never
  user text — so remote paths need no escaping beyond the workDir itself.

## 5 Record — the `ComputeJob` entity

`packages/record/src/types.ts`:

```ts
type ComputeJobState =
  "submitted" | "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";

interface ComputeJob {
  id: string;                 // `cjob-<ts36>-<rand>` (the directory.ts id shape)
  projectId: string;
  endpointId: string;
  kind: "slurm" | "linux";    // snapshot — the row stays self-describing after the endpoint is deleted
  remoteJobId?: string;       // slurm job id / linux pid (set once, at submit)
  name: string;
  script?: string;            // slurm: full sbatch body snapshot
  command?: string;           // linux: command-line snapshot
  resources?: { partition?; nodes?; ntasks?; cpusPerTask?; mem?; time? };
  state: ComputeJobState;
  exitCode?: number;
  nodeList?: string;
  sessionKey?: string;        // submitting Session; best-effort (§7)
  error?: string;             // last submit/reconcile error
  submittedAt: number; startedAt?: number; finishedAt?: number; updatedAt: number;
}
```

- `RecordStore` gains `upsertComputeJob` / `loadComputeJob` /
  `listComputeJobs(projectId)` (JSONL + in-memory; idempotent upsert keyed by
  `id`), mirroring the Subagent methods.
- `deleteProject` cascades ComputeJob rows (extend the docs/adr/0014 cascade);
  `deleteSession` does NOT (jobs belong to the Project).
- The adapter-facing `RecordStoreLike` is untouched — the service writes
  jobs directly; no adapter sink change.

## 6 SSH layer — `src/hpc/ssh.ts`

- `runSsh(endpoint, { command, stdin?, timeoutMs })` spawns
  `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
  -o ControlMaster=auto -o ControlPersist=600 -o ControlPath=<tmp>/cm-<endpointId>
  [-i keyPath] [-p port] [user@]host -- <command>`; returns
  `{ code, stdout, stderr }`. `scpTo/scpFrom` carry the same `-o` set.
- Everything remote is a fixed argv built by the service; interpolated
  user-derived scalars (workDir, partition, name) pass through `shq()` —
  POSIX single-quote escaping. Remote output is data: never `eval`'d, never
  path-assembled from a remote reply.
- Sockets/tmp artifacts live under `$TMPDIR/science-studio/hpc/`, 0600, one
  dir per service process (same discipline as the bridge socket).
- `ControlPersist=600` lets a dead control master self-expire; no pool to
  manage, and a killed service leaks at most a socket file.

## 7 Routes — `/api/hpc/*`

All Project-scoped through `scope.acquire` (query-first claim); the web hop is
one `app/api/hpc/[[...path]]/route.ts` catch-all relaying via `proxyToService`
(docs/adr/0021: verbatim status/body, forward Authorization).

| Route | Contract |
|---|---|
| `GET /api/hpc/binding?projectId` | `{ raw, binding?, error? }` |
| `PUT /api/hpc/binding?projectId` | body = serialized binding; writes through the Workspace seam |
| `GET /api/hpc/endpoints` | the `hpc` view (endpoints as-is) |
| `POST /api/hpc/endpoints/:id/probe` | connect + `uname -a` + (`sbatch --version` when slurm) + `mkdir -p` workDir; answers `{ ok, hostname, os, scheduler?, workDirCreated?, errors: [...] }` — per-check, never a thrown 500 |
| `GET /api/hpc/jobs?projectId` | ledger rows, non-terminal first then newest-first |
| `POST /api/hpc/jobs` | submit — §7.1 below |
| `POST /api/hpc/jobs/:id/cancel` | `scancel <id>` / `kill -TERM -<pid>` (setsid ⇒ pgid=pid); row→`cancelled`; a terminal row answers 409 |
| `GET /api/hpc/jobs/:id/logs?stream=stdout\|stderr&tailBytes=65536` | `tail -c` over ssh from the stored log paths |
| `POST /api/hpc/jobs/refresh?projectId` | `poller.tick({ projectId })`, then the fresh list |
| `POST /api/hpc/files` | `{ projectId, action: "upload"\|"download", workspacePath, remoteRelPath }`; upload: Workspace `open` → `scpTo`; download: `scpFrom` → Workspace `write` (quota + containment inherited); size caps as other workspace routes |

### 7.1 Submit flow

1. Resolve scope → binding → endpoint (errors above).
2. **Runaway guard:** count the Project's non-terminal rows on this endpoint;
   `maxConcurrentJobs > 0 && count >= max` → 429 with the limit named.
   (systemPrompt rule §9 is the first line of defence; this is the hard one.)
3. `mkdir -p` the job dir; write `script.sh` via stdin (slurm) or build the
   wrapper (linux).
4. **slurm:** prepend `#SBATCH` directives (resource params + `-J ss-<id8>` +
   `-o/-e` into the job dir) ABOVE the model's script — Slurm last-directive
   wins, so a self-authored `#SBATCH` in the body overrides, which is the
   documented convention. Run `sbatch --parsable` with the script on stdin;
   parse `jobid` / `jobid;cluster`.
5. **linux:** `setsid sh -c '<cmd> >stdout 2>stderr; echo $? >rc' & echo $! >
   pid` under `nohup`; parse the pid.
6. Upsert the `submitted` (slurm: `pending`) row with remote id, resource
   snapshot, and the §7.2 session claim.
7. An `sbatch` that exits 0 but prints an unparsable id: **write no row**,
   answer 502 `{ error: "sbatch reported success but no job id was readable —
   the job may be queued; check the cluster before retrying" }`.

### 7.2 Session attribution (best effort, no new seam method)

The plugin sends the harness session id it knows from its own agent context;
the service maps it to a record Session only if the active dsh adapter can
resolve that runtime key to one (it already owns the mapping); the raw key is
kept regardless, and the UI only renders the jump link when `sessionKey`
resolves to a listed Session.

## 8 Poller — `src/hpc/poller.ts`

`createHpcJobPoller({ records, settingsPath })`, decorated `app.hpcPoller`,
started only by `index.ts`'s `isMain` (cron shape; tests call `tick()`):

- 15 s tick. Re-reads the endpoint list from the settings file each tick
  (hot-apply). Selects non-terminal + `unknown` rows grouped by endpoint.
  **Zero rows → zero SSH.** No target, no lock needed — this touches no Run.
- **slurm:** one batched `squeue -h -o "%i|%t|%D|%n|%r" --job=<ids>` per
  endpoint; when a row leaves `squeue`, one `sacct -n -P -X -j <id>
  --format=JobID,State,ExitCode,Start,End,Elapsed,NodeList` to settle
  completed/failed + timings; `unknown` in both answers keeps last-known,
  bumps an error counter, and stops polling after 3 consecutive failures with
  the reason recorded.
- **linux:** one script per endpoint probes each job dir: `rc` present →
  `completed`/`failed` by exit code; else `kill -0 <pid>` → `running`; else
  `unknown`. A row cancelled by the route settles on its `rc`.
- The poller never invents rows: external jobs on the cluster are invisible
  to the product by design (docs/adr/0024).

## 9 dsh child plugin — `hpc-plugin.ts` + `writeHpcPatch`

- `export const name = "science-studio-hpc"`, `inject = ["tools",
  "systemPrompt"]`. Mounted with project+config like project/cron: only for a
  real Project, inert otherwise; fails soft; stderr-only; structural host
  views, no `@deepseek-ai/*`.
- Patch config: `{ project: { id }, service?: string }` — service URL from
  `SCIENCE_STUDIO_SERVICE_URL` env (default `http://127.0.0.1:3001`, the
  molql-plugin convention); the fetch uses `node:http` (no global-fetch
  assumption on the child's runtime).
- Tools: `hpc_submit` (`{ name, script | command, partition?, nodes?,
  ntasks?, cpusPerTask?, mem?, time? }`), `hpc_jobs` (`{ state? }`),
  `hpc_cancel` (`{ jobId }`), `hpc_logs` (`{ jobId, stream? }`),
  `hpc_files` (`{ action, workspacePath, remoteRelPath }`) — bodies add
  `{ projectId }` from patch config. Each maps the route's JSON to model text;
  a fetch/5xx failure is a tool error result, never a throw into the turn.
- One `systemPrompt` section, order **465** (project 450, subagent-reporting
  455, cron 460): endpoint + binding semantics, Remote Work Dir and job-dir
  layout, "state resources in chat before submitting; `hpc_jobs` first; never
  re-submit an ambiguous one; jobs never see the Project Workspace directly."
- `DshRuntimeAdapter.initialize` pushes `writeHpcPatch(...)` onto the patch
  list beside the other five writers, only when `opts.project` is present.

## 10 Workbench surfaces

- **Settings → HPC tab** (`hpc-tab.tsx`, owns its fetch/error/retry state like
  the Skills tab): an endpoint list editor (add/remove/edit fields, kind
  selector, per-endpoint **Test connection** with inline per-check results)
  saved through the one `PUT /api/settings`; below it a "This Project" block —
  endpoint picker + partition/workDir/time overrides + notes — read and written
  over `/api/hpc/binding`, with a dangling-endpoint warning banner.
- **Right panel → Jobs section** (fourth `RightSectionId: "jobs"`, store +
  `right-panel.tsx` + collapsible `SidebarSection` like the others):
  `useHpcJobs` polls 5 s while visible with a scope (transport-client hook;
  failure keeps last good, docs/adr/0021); header has a Refresh action (the
  forced-tick route). Columns: status chip, name, `#remoteJobId`, partition,
  submitted, elapsed, submitting-Session chip. Cancel per row (confirm).
  Double-click → synthetic tab `hpc:<cjobId>` (tab-strip branch +
  `FilePreviewPane` case, modelled on `subagent:<childId>`): Details row
  (endpoint, kind, resources, nodes, timings, exit code, error) +
  script/command block + stdout/stderr tail viewer with a refresh.
- **Delete-project dialog:** warns `N running Compute Jobs — deleting does
  not stop them` (cluster non-authority, docs/adr/0024).
- Empty state (no endpoints configured): a copy line pointing at Settings →
  HPC, not an error.

## 11 Failure policy (docs/adr/0021 mapping)

Routes never rewrite SSH/cluster errors (the service formats them once);
proxies relay verbatim; client hooks keep last-good (jobs list), degrade to
empty (endpoints), or show retry (binding, probe). A missing binding is a
successful 400-shaped answer consumed politely by the tools/panel, not a
5xx.

## 12 Test plan

- `packages/hpc/test/`: binding codec round-trips + malformed; slurm state
  map; job-layout paths.
- `packages/record/test`: ComputeJob upsert/list, deleteProject cascade (both
  store impls).
- `packages/transport/test/seams.test.ts`: new exports on the list.
- `services/transport-service/test/`: `parseSettingsPatch` hpc branch (400s);
  submit flow against a **fake `ssh` PATH shim** (a script answering canned
  sbatch/squeue/sacct/tail outputs) — happy slurm + linux, ambiguous sbatch,
  guard 429, cancel, logs; poller reconcile incl. 3-strike unknown; routes
  400/404/409/429/502 semantics.
- `packages/transport-dsh/test/`: plugin fail-soft + inert-without-project;
  tool fetch error mapping; `writeHpcPatch` YAML snapshot.
- `apps/web/test/`: jobs-panel regression (mocked `/api/hpc`, re-render
  invariants); HPC tab smoke (browserless where possible).

## 13 Explicitly deferred (v1 boundaries)

Queue depth / utilization stats · job arrays · MPI multi-node specifics ·
remote-directory browsing ("remote as Workspace") · host-key TOFU pinning ·
openclaw tool parity · auto-retry / job dependency graphs · per-user HPC
credentials in hosted mode · cost accounting · log `follow` streaming.
