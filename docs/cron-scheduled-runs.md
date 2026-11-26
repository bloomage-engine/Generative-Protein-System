# Per-Project scheduled runs (cron)

Cron is the subsystem that lets a Project re-run an agent turn on a schedule
("every morning, summarise the new results"). Its one governing idea, from
docs/adr/0017: **a task is a workspace file, the service owns the clock, and the
agent holds only the authoring surface.** Four layers implement that split; each
is read-only with respect to the layer below it.

```
author (dsh child plugin)  ──writes──▶  .gps/cron/<id>.md  ◀──reads── scheduler (service)
                            same codec (packages/cron)                    UI (polls /api/cron*)
```

## 1. The codec — `packages/cron` (pure, zero-dependency)

Shared by all three consumers; the single source of truth for the file format.

- `task-doc.ts` — a task is `<id>.md` under `.gps/cron/`: simple
  `key: value` frontmatter with JSON-quoted strings (`name`, `schedule`,
  `enabled`, optional `sessionId` / `createdAt` / `updatedAt`) and the prompt as
  the body. **The id IS the filename** (`^[a-z0-9][a-z0-9-]{0,63}$`); there is no
  record row.
- `schedule.ts` — the restricted 5-field grammar (minute hour day-of-month month
  day-of-week; `*`, ranges, lists, steps; no names, no `@` macros, no seconds)
  with `parseSchedule` / `isValidSchedule` / `matchesSchedule`, plus the
  hourly/daily/weekly presets the UI offers. Two documented deviations from
  POSIX cron: **every field is ANDed** (POSIX ORs a restricted dom with a
  restricted dow, so a schedule limiting both fires LESS often than a POSIX user
  expects), and matching uses the **server's local time** (`Date` getters).
- `log.ts` — the sibling `<id>.log.md`: one `## <at> · <status>` block appended
  per fire, status ∈ `success | skipped-busy | error`, with optional
  `session:` / `run:` lines and a message body. Parsing is forgiving (malformed
  sections are ignored).

## 2. The service side — `services/transport-service/src/cron/`

- `store.ts` — `CronStore`: list/read/write/remove + `appendLog`, built entirely
  on the **Workspace seam** (`list`/`open`/`write`/`delete`), so every path
  inherits FsWorkspace's containment/symlink/size invariants. A malformed task
  document is surfaced in the `invalid` list, never fatal.
- `routes.ts` — `/api/cron*` (list, get/create/update/delete task,
  `POST /task/run`). Every route resolves the scope through `ProjectScopes`, so
  it is the same `(projectId, main worktree)` environment the rest of the
  product uses. Create slugs the name into an id and de-duplicates with `-2`,
  `-3`…
- `scheduler.ts` — `CronScheduler`, the authority:
  - A **30 s tick** scans every Project, acquires its `main` Environment and
    **re-reads the task files every time** — no cache, so a hand-edit lands on
    the next tick and a restart resumes with no recovery step.
  - A `firedMinutes` map guarantees at most one attempt per scheduled minute
    (the 30 s tick would otherwise match each minute twice).
  - A fire takes the **same `activeRuns` one-in-flight-run lock** as the
    transport route (keyed `tenant:sessionId`), so a scheduled run and a user
    run can never interleave on one Session; a busy target is logged
    `skipped-busy` and dropped.
  - The fire itself is an **ordinary `adapter.run()`** with one `add-message`
    command (`cron-<at>-<taskId>`): the Run is recorded, the turn lands in the
    Session transcript, watchers see it — runtime-wise it is indistinguishable
    from a user turn. The final assistant text (bounded to 4 000 chars) is
    mirrored into the task log.
  - Target resolution: an explicit `sessionId` must belong to the firing
    Project AND to the **main worktree** (docs/adr/0025); a linked-worktree
    target is refused with the reason logged, an omitted one resolves to the
    Project's newest main-worktree Session, and no target logs `error`.
  - Lifecycle: decorated as `app.cronScheduler` but **started only by
    `index.ts`'s `isMain`**; tests and embedders call `tick()`/`fire()`
    directly. Hosted mode resolves no service principal, so the scheduler
    no-ops there (routes still answer; run-now returns `error`).
  - Fault isolation is layered (per task, per Project, per tick): one unreadable
    workspace never starves the rest.
  - **Missed fires are skipped** — a minute the service was down is never
    caught up and two fires are never coalesced.

## 3. The agent side — `packages/transport-dsh/src/cron-plugin.ts`

The third per-launch child plugin (docs/adr/0011's patch mechanism, see
docs/dsh-child-plugins.md). It registers `schedule_create` / `schedule_list` /
`schedule_delete` / `schedule_set_enabled`, a `/cron` command and one
system-prompt section teaching the 5-field syntax, the main-only rule and
"only schedule when the user explicitly asks".

Unlike the HPC/worktree plugins, it does **not** call the service: it writes the
task files directly with the shared codec, because **the file is the authority**
— what the agent writes is exactly what the scheduler reads, no IPC. Two
gating rules: it mounts only for a real Project, and its `root` is pinned to the
**main** workspace (not the active worktree's cwd), since the service only ever
reads `<project root>/.gps/cron/`.

## 4. The UI side

- `apps/web/app/api/cron/[[...path]]` relays `/api/cron*` through the one proxy
  policy (docs/adr/0021).
- `@gps/transport-client`'s `useCronTasks` polls
  `GET /api/cron?projectId` every 2 s while the panel is open (keep-last-good on
  failure).
- `components/studio/cron-view.tsx` (right-panel section),
  `renderers/CronTaskRenderer.tsx` (a task file opened as a tab, with its run
  log), and `cron-new-task-dialog.tsx` (preset → expression via the codec).
- `.gps/cron/` files are listed by the file tree like any other path.

## End-to-end sequence

```
user: "summarise the experiments every morning at 9"
  agent → schedule_create (child plugin)
  → write <root>/.gps/cron/morning-summary.md        (agent's part ends here)
service CronScheduler (30 s tick, no agent process involved):
  → re-read files → matchesSchedule("0 9 * * *", now)
  → take activeRuns[tenant:sessionId] → adapter.run(add-message prompt)
  → Run recorded · lands in the Session transcript · pushed over SSE
  → append "## <at> · success" to <id>.log.md
UI: useCronTasks sees lastRun
```

## Accepted trade-offs (from docs/adr/0017)

- Clock in the service, not the child: a child is per-Project, lazily spawned
  and killed on restart, but a task must fire even when nobody has prompted that
  Project since boot.
- Not a record entity: the v1 record stays Project/Session/Run (docs/adr/0007),
  and a file keeps the task visible in the agent's own cwd.
- A `skipped-busy` fire is dropped with only a log line, so a schedule tighter
  than the Session's real run cadence silently loses fires.
- `.gps/` is now a product-owned namespace inside every Project
  Workspace (shared with the Project Scaffold, docs/adr/0012); deleting a
  Project recycles the whole workspace, cron files included (docs/adr/0014).

## Verification

`packages/cron/test/` (codec, schedule grammar, log),
`services/transport-service/test/cron-{store,routes,scheduler}.test.ts` and
`packages/transport-dsh/test/cron-{plugin,launch,main-root}.test.ts`.
