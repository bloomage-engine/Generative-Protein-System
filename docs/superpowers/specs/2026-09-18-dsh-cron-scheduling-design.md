# dsh cron scheduling — per-Project scheduled agent runs (design)

Date: 2026-09-18
Status: approved

## Goal

Give the workbench **per-Project scheduled tasks**: a task fires at a cron
schedule, the service drives a normal agent run on its target Session with the
task's prompt, and the result lands in that Session's transcript (recorded as a
`Run`) plus an append-only log file. Tasks are created by the agent (dsh child
tools) or from the UI, listed in the existing right-pane **Cron** module, and
opened for viewing/editing in the existing file-tab system via a dedicated
form renderer.

## Motivation

The right pane already reserves a Chron section
(`docs/superpowers/specs/2026-09-17-right-panel-collapsible-sections-design.md`)
but it is an empty shell with no data source. A research workbench needs
recurring autonomous work ("every morning digest the feeds into `NOTES.md`",
"every hour check the long-running experiment"). The harness ships
`@deepseek-ai/dsh-schedule`, but it is agent-scoped and not mounted by the `sdk`
profile; we need Project-scoped scheduling that survives a cold child and is
visible/editable where the rest of the work lives.

## Scope

In scope:

- A new pure package `@science-studio/cron` (task-document codec, cron matcher,
  presets, log entry helpers) shared by the service and the dsh child plugin.
- A service-owned scheduler that scans each Project's task files, matches the
  wall clock, and drives `adapter.run()` for due tasks.
- Cron task CRUD routes on the transport-service, proxied through the web.
- A dsh child plugin (`cron-plugin.ts`) exposing agent tools (`schedule_create`,
  `schedule_list`, `schedule_delete`, `schedule_set_enabled`), a `/cron` command
  and a system-prompt section; mounted through the existing per-launch patch.
- `transport-client` hooks (`useCronTasks`, create/save/delete/run-now).
- `CronView` as a real list with a "New task" dialog and double-click-to-open.
- A `CronTaskRenderer` (view + form + run history) routed by task path.

Out of scope (unchanged):

- Shell/script tasks, tasks that do not run an agent turn.
- Cross-Project tasks; a task belongs to exactly one Project's workspace.
- Catch-up runs for occurrences missed while the process was down.
- A record type for tasks (the record stays Project/Session/Run; the task file
  is the authority — docs/adr/0007).
- Hosted/enterprise scheduling identity (single-user local principal only).

## Decisions

- **The task file is the authority.** A task is a workspace file
  `.science-studio/cron/<id>.md` with YAML-ish frontmatter and a prompt body. The
  agent tool, the UI form and the scheduler all read/write the same file, so an
  external edit is picked up on the next scan. No record row.
- **The scheduler lives in the service, not the child.** The service is always
  up while the app runs and can wake a cold child; a child-resident timer would
  miss fires whenever no Session is active and would die on restart (the user
  explicitly chose this).
- **The child plugin is the agent surface only.** It registers tools/commands
  and a prompt section; it does not schedule and does not execute. It writes the
  task file directly (its cwd IS the Project workspace, exactly like
  `project-plugin.ts`), using the shared codec.
- **One shared codec.** `@science-studio/cron` is pure (zero dependencies,
  browser-safe) and is a declared dependency of `transport-service`,
  `transport-dsh` (the child plugin imports it as an ESM runtime dependency,
  resolved from the monorepo's `node_modules`) and `transport-client` (types +
  human-readable schedule). This avoids a second implementation drifting. It is
  added to the root build chain before its consumers.
- **No new runtime capability flag.** Scheduling is service-level and works for
  any adapter; only the agent tools/`/cron` are dsh-specific. `RuntimeCapabilities`
  is unchanged.
- **Execution reuses the normal run path.** The scheduler calls
  `adapter.run(session, [{type:"add-message", …}])` and drains the deltas. The
  kit persists the `Run` and updates the transcript as for any user turn. The
  service's existing `activeRuns` set is the one-in-flight lock, shared with the
  transport route.
- **Schedule grammar is a documented 5-field subset with AND semantics.** Minute
  / hour / day-of-month / month / day-of-week, each `*`, `n`, `a-b`, `a,b`,
  `*/n` or `a-b/n`; a task fires when the current wall-clock minute matches ALL
  five fields (standard cron ORs day-of-month and day-of-week; we do not). Local
  time. Presets (hourly / daily / weekly) write canonical expressions.
- **Missed fires are skipped; busy targets are skipped.** No catch-up on
  startup; if the target Session has an in-flight run, the occurrence is logged
  `skipped-busy` and not retried. Within a tick, due tasks are awaited in order,
  so one long run delays later due tasks for that tick (and their occurrence is
  then skipped rather than queued); each task fires at most once per matching
  minute.
- **The scheduler is a controller, not an auto-start side effect.**
  `createServer()` builds it (so it shares `scope`/`activeRuns`) and exposes it
  on the Fastify instance; only the real entry point (`index.ts` `isMain`) calls
  `start()`. Tests construct the app and drive `tick()` deterministically.

## Data model

Under each Project's workspace root (`<PROJECT_ROOT>/<projectId>/`):

```
.science-studio/cron/
  <id>.md          # task definition
  <id>.log.md      # append-only run log (sibling)
```

`<id>.md`:

```markdown
---
name: Daily arXiv digest
schedule: "0 9 * * *"
enabled: true
sessionId: "sess-abc"
createdAt: 2026-09-18T01:00:00.000Z
updatedAt: 2026-09-18T01:00:00.000Z
---
每天检索 arXiv 上关于 <主题> 的新论文，把摘要追加到 NOTES.md。
```

- `id` is the filename stem, matching `^[a-z0-9][a-z0-9-]{0,63}$` (slug of the
  name, unique-suffixed). It never changes after creation.
- `schedule` is the canonical 5-field expression.
- `sessionId` is optional on disk; the UI requires it. The agent tool accepts it
  as well, but the child cannot know the Science Studio session key, so when it
  is absent the scheduler targets the Project's most recently updated non-archived
  Session and records the resolved id in the log. A named Session that is
  missing, archived, or belongs to another Project is a per-fire error.
- `enabled` defaults to `true`.
- The body after the closing `---` is the prompt, verbatim (leading blank line
  trimmed).

`<id>.log.md`: for each fire, one section appended:

```markdown
## 2026-09-18T09:00:00.000Z · success
- session: sess-abc
- run: run-xyz

<assistant text, or the error/skip message>
```

`@science-studio/cron` exports:

```ts
export const CRON_DIR: string; // ".science-studio/cron"
export interface CronTask {
  id: string; name: string; schedule: string; enabled: boolean;
  sessionId?: string; prompt: string; createdAt?: string; updatedAt?: string;
}
export type ParseResult = { task: CronTask } | { error: string };

export function cronTaskPath(id: string): string;
export function cronLogPath(id: string): string;
export function isCronTaskPath(path: string): boolean;   // dir + *.md, excluding *.log.md
export function taskIdFromPath(path: string): string | null;
export function parseTaskDoc(id: string, text: string): ParseResult;
export function serializeTaskDoc(task: CronTask): string;

export function isValidSchedule(expr: string): boolean;
export function matchesSchedule(expr: string, at: Date): boolean;
export function describeSchedule(expr: string): string;  // human label
export type SchedulePreset = "hourly" | "daily" | "weekly";
export const SCHEDULE_PRESETS: readonly { id: SchedulePreset; label: string }[];
export function presetToExpression(
  preset: SchedulePreset,
  at?: { hour?: number; minute?: number; weekday?: number },
): string;

export type CronRunStatus = "success" | "skipped-busy" | "error";
export interface CronLogEntry {
  at: string; status: CronRunStatus; sessionId?: string;
  runId?: string; message?: string;
}
export function appendLogEntry(existing: string, entry: CronLogEntry): string;
export function latestLogEntry(existing: string): CronLogEntry | null;
```

## Architecture

```
agent ──(schedule_create)──► writes .science-studio/cron/<id>.md        (child proc)
web UI ──(form)──► POST/PUT /api/cron/task ──► service writes the file   (service)
                        │
service CronScheduler (tick, default 30s)
   for each non-archived Project:
     acquire Environment (adapter + workspace)
     list .science-studio/cron/*.md, parse
     if enabled && matchesSchedule(now):
        resolve target Session (record)
        if activeRuns has the session → append skipped-busy log
        else adapter.run(session, add-message{prompt}) → drain
             append success/error log (+ final assistant text)
```

### `@science-studio/cron` (new package)

Pure, dependency-free, browser-safe. No `node:*` imports (path helpers are
string operations), so the web client may import it. Files:
`src/index.ts` (exports), `src/task-doc.ts` (parse/serialize/paths),
`src/schedule.ts` (matcher/presets/describe), `src/log.ts` (append/latest).
Built with `tsc -b`; suite `node --import tsx --test test/*.test.ts`.

### Service — `services/transport-service/src/cron/`

- `store.ts`: workspace-backed task store. `list(workspace)`, `read(workspace,id)`,
  `write(workspace, task)`, `remove(workspace, id)`, `appendLog(workspace, id,
  entry)`, `listLog` (for the UI's recent history). Uses `Workspace.list/open/
  write/delete`; reads are byte-capped; writes go through `Workspace.write`
  (atomic temp+rename by the implementation). Path building is `@science-studio/cron`.
- `scheduler.ts`: `createCronScheduler(deps)` with
  `deps = { records, environments, directory, principal, activeRuns, now?, tickMs? }`.
  Public: `tick(): Promise<void>`, `start(): void`, `stop(): void`. `start()`
  uses an interval (`unref()`), guarded so overlapping ticks cannot run
  (`ticking` flag); `tick()` is the test seam. Per due task it builds the
  `SessionState` from the record, calls `adapter.run`, drains, and appends the
  log. All failures are caught per task and logged; one bad task never stops the
  loop.
- `routes.ts`: `registerCronRoutes(app, deps)` registering the routes below.
- `server.ts`: builds the scheduler after `scope`/`activeRuns` exist, decorates
  `app.cronScheduler` (`declare module "fastify"` typing added), and calls
  `registerCronRoutes`. The scheduler is NOT started here.
- `index.ts`: in the `isMain` branch, `app.cronScheduler.start()` before/after
  `listen` (and a best-effort `stop()` on shutdown).

### Child plugin — `packages/transport-dsh/src/cron-plugin.ts`

Follows `project-plugin.ts` verbatim in shape: local structural host interface,
`export const name`, `export const inject = ["tools", "commands", "systemPrompt"]`,
`apply(ctx, config)`, dependency-free from `@deepseek-ai/*`, never writes stdout,
all registration guarded. Config: `{ project, root }` (root = the child cwd =
Project workspace). It imports `@science-studio/cron` for the codec and
`node:fs` for IO.

- Tools: `schedule_create({ name, schedule, prompt, sessionId?, enabled? })`,
  `schedule_list()`, `schedule_delete({ id })`,
  `schedule_set_enabled({ id, enabled })`. `schedule_create` validates the
  schedule and the name, slug-uniquifies the id, writes the file atomically, and
  returns `{ id, path }`. `sessionId` defaults to the invoking agent's Session
  when the execution context exposes one.
- Command `/cron`: lists the Project's tasks (id, name, schedule, enabled).
- Prompt section: documents the directory, the frontmatter fields, the schedule
  subset/ presets and the four tools.
- Adapter wiring: `writeCronPatch()` in `bridge.ts` (same `- insert:` shape as
  `writeBridgePatch`/`writeProjectPatch`); `cronPluginPath` option (default
  `./cron-plugin.js`); `adapter.initialize()` pushes the patch when `opts.project`
  exists, best-effort like the other two. `/cron` is added to
  `DSH_HARNESS_FALLBACK_DESCRIPTORS` in `commands.ts` so the cold menu is
  complete.

### Client — `packages/transport-client/src/cron.ts`

Re-exports the `CronTask`/`CronLogEntry`/preset types from
`@science-studio/cron` and adds:

```ts
export interface CronTaskSummary extends CronTask { lastRun?: CronLogEntry; path: string }
export function useCronTasks(opts: { api?: string; projectId: string | null; enabled: boolean; intervalMs?: number }): {
  tasks: CronTaskSummary[]; invalid: { path: string; error: string }[];
  loading: boolean; error: string | null; refresh: () => void;
};
export function createCronTask(api, projectId, input): Promise<CronTask>;
export function saveCronTask(api, projectId, task): Promise<CronTask>;
export function deleteCronTask(api, projectId, id): Promise<void>;
export function runCronTask(api, projectId, id): Promise<{ status: CronRunStatus }>;
export function fetchCronTask(api, projectId, id): Promise<CronTask>;
```

`useCronTasks` mirrors `useSubagents`: poll only while `enabled`, keep the last
good list on failure, abort on scope change.

### Web UI

- `apps/web/app/api/cron/[[...path]]/route.ts`: proxy `GET`/`POST`/`PUT` to the
  service via `proxyToService` (relay query verbatim), reconstructing the
  upstream path as `/api/cron` + the catch-all segments.
- `CronView` (`cron-view.tsx`): real list. Reads the active `projectId`; when the
  section is open and a Project is set, it calls `useCronTasks`. Rows show name,
  human-readable schedule (`describeSchedule`), enabled dot, last-run status.
  Header action: a "New task" button. Double-click a row →
  `openFile(path, name)`. Empty state keeps the current copy; a workspace-
  unavailable state reuses the files module's friendly copy; malformed files
  render a small warning count from `invalid`.
- `NewCronTaskDialog` (`cron-new-task-dialog.tsx`): name, schedule (preset or
  custom, shared fields), target Session (from the record's Sessions), prompt.
  On submit → `createCronTask` → refresh → `openFile` the new task's tab.
- `CronTaskRenderer` (`renderers/CronTaskRenderer.tsx`): the tab view. Header
  shows the task name; body is a form (name, schedule preset/custom, target
  Session, enabled, prompt), with Save / Delete / Run-now, and a "recent runs"
  list parsed from the log. Loads via `fetchCronTask(projectId, idFromPath)`;
  Save via `saveCronTask`; Delete confirms then closes the tab.
- Routing: `file-utils.ts` gains `isCronTaskPath` re-export/uses
  `@science-studio/cron`'s predicate; `Preview` (`file-preview-pane.tsx`) checks
  `isCronTaskPath(path)` FIRST and renders `CronTaskRenderer`; otherwise the
  existing kind dispatch is unchanged. `file-icons.tsx` gains a cron icon and
  `tab-strip.tsx` uses it for cron paths.
- The tab identity stays the real workspace path/name, so the existing
  mounted-tab/scroll-preservation mechanism is untouched.

## API surface

All routes resolve the Project through `scope` (query `projectId` first, else
default) exactly like the workspace routes.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/cron?projectId=` | `{ tasks: CronTaskSummary[], invalid: {path,error}[] }` |
| GET | `/api/cron/task?projectId=&id=` | `{ task: CronTask }` or 404 |
| POST | `/api/cron/task?projectId=` | create; body `{name,schedule,prompt,sessionId?,enabled?}` → 201 `{task}` |
| PUT | `/api/cron/task?projectId=&id=` | save; body is the full task → `{task}` |
| POST | `/api/cron/task/delete?projectId=&id=` | remove task + log; **idempotent** — 200 `{ok:true}` even for an unknown id |
| POST | `/api/cron/task/run?projectId=&id=` | run once now (same path as a fire) → 200 `{status}` (`success` / `skipped-busy` / `error`) |

Validation: 400 on invalid schedule/name/body; 404 unknown id on read/update;
503 no workspace (via `withWorkspace`). Delete is deliberately idempotent (a UI
button may double-click or retry); run-now reports its outcome as a status rather
than an HTTP error.

## Data flow

Creation (UI): `NewCronTaskDialog` → POST → `store.write` serializes via the
codec → file appears → list refresh → tab opens → `CronTaskRenderer` fetches the
parsed task. Creation (agent): `schedule_create` → same codec → same file. Fire:
scheduler tick → parse → match → `adapter.run` → kit persists Run + transcript →
`appendLogEntry`. Editing the file by hand is indistinguishable from an API edit
at the next scan.

## Error handling

- **Malformed task file:** the store returns it under `invalid` (not `tasks`); the
  scheduler skips it with a stderr warning; the UI shows a warning count.
- **Unknown/archived target Session:** per-fire `error` log entry; no run.
- **Busy target:** `skipped-busy` log entry; no retry.
- **Adapter/run failure:** caught; `error` log entry; loop continues.
- **No workspace (`NullWorkspace`):** list/CRUD answer 503 through
  `withWorkspace`; `CronView` shows the unavailable copy and disables New.
- **Path safety:** ids are validated; every path is built inside
  `.science-studio/cron/`; the Workspace seam enforces containment.
- **Overlapping ticks:** a `ticking` guard skips a tick that starts before the
  previous finishes.

## Testing

- `packages/cron/test/*.test.ts`: schedule matcher (fields, ranges, lists, steps,
  AND semantics, DST-safe local minute), presets/describe, task-doc round-trip,
  path predicate and id extraction, log append/latest.
- `packages/transport-dsh/test/cron-plugin.test.ts`: scripted structural host;
  tool registration; create writes a parseable file, list/delete/set-enabled;
  invalid schedule rejected; no stdout writes.
- `packages/transport-dsh/test/cron-launch.test.ts`: the cron patch is on the
  launched argv and names the plugin file (mirrors `project-launch.test.ts`).
- `services/transport-service/test/cron.test.ts`: CRUD routes over a temp
  `FsWorkspace`; `scheduler.tick()` with a fake clock fires a stub adapter on
  match, skips when disabled, logs `skipped-busy` when `activeRuns` holds the
  Session, logs `error` for an unknown Session, and does not auto-start (no
  timers leak).
- `apps/web/test/cron-panel.test.mjs` (Chromium-gated, mocks `/api/cron`): list
  renders rows, New dialog posts and opens a tab, double-click opens a tab, the
  renderer's Save PUTs, and cron tabs preserve state like other tabs.
- `npm run build` (includes `typecheck:tests`) is the gate; the new package is
  added to the build chain before its consumers.

## Risks

- **AND vs OR cron semantics.** Standard cron ORs day-of-month/day-of-week; we
  AND them (no surprising "runs on every 1st AND every Monday" fires). Documented
  in the prompt section and the form hint.
- **Local time / DST.** Matching uses the process's local minute; a spring-
  forward gap can skip an occurrence and a fall-back hour can double-fire once.
  Acceptable for v1; noted, not handled specially.
- **Child/service concurrent writes.** Both write via the same codec; the
  Workspace's temp+rename keeps readers from seeing partial files.
- **Workspace tree reacting to a dot-dir `activeTabPath`.** Opening a cron tab
  sets `activeTabPath` to a path under `.science-studio/`; verify
  `workspace-tree.tsx`'s reveal logic no-ops harmlessly for a path outside the
  visible tree.
- **openclaw Projects.** The scheduler and UI work for any runtime, but agent
  tools/`/cron` exist only in dsh. This is intended (UI-created tasks still fire).
- **Hosted mode.** The scheduler resolves the local principal at start; in
  hosted mode (bearer principals) it should be disabled or given a service
  principal. Out of scope; guard so a failed resolution disables the scheduler
  rather than throwing.
