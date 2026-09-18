# Cron scheduling is service-owned and a task is a workspace file

Per-Project **Scheduled Runs** are ordinary workspace files under
`.science-studio/cron/` — a task document (`<id>.md`: frontmatter + prompt body)
and a sibling run log (`<id>.log.md`) — and the transport-service owns the clock:
a `CronScheduler` scans each Project's task files, matches the wall clock, and
drives `adapter.run()` on the target Session while holding the server's shared
one-in-flight-run lock. The dsh adapter contributes only the agent's authoring
surface (tools, `/cron`, a prompt section) through a third per-launch child
plugin.

- **Status**: accepted
- **Context**: the product wanted per-Project recurring agent runs ("every
  morning, summarise …"). The record vocabulary for v1 is Project/Session/Run
  (docs/adr/0007) and has no schedule entity, while a run is already recorded
  when it happens — the only missing pieces are a durable task definition and a
  clock. The clock cannot live in the dsh harness child: a child is per-Project,
  spawned lazily and killed on restart (docs/adr/0008), and a task must fire even
  when nobody has prompted that Project since the service started — the child may
  be cold entirely. Splitting the other way (service owns the clock, child owns
  authoring) also keeps the file model honest: the file is what both sides read,
  so the agent can author a task the service will honour with no IPC round-trip.
  *Considered and rejected*: a record entity (a `Schedule`/`Artifact` row) as the
  authority. It would put a scheduler-shaped type into a record layer that
  docs/adr/0007 deliberately keeps to Project/Session/Run, and it would hide the
  task from the agent's own cwd. *Considered and rejected*: an external cron
  driving `POST /api/transport`. It moves state outside the Project Workspace and
  gives the agent no way to author a task.
- **Decisions**:
  - **A task is a workspace file; the file is the authority.**
    `<PROJECT_WORKSPACE>/.science-studio/cron/<id>.md` carries simple
    `key: value` frontmatter (JSON-quoted strings: `name`, `schedule`, `enabled`,
    optional `sessionId`, `createdAt`, `updatedAt`) and the prompt as the body;
    `<id>.log.md` is appended one `## <at> · <status>` block per fire. The
    zero-dependency `@science-studio/cron` package is the codec both sides share
    (`parseTaskDoc` / `serializeTaskDoc` / `appendLogEntry`); no record row is
    written for a task, and a malformed file is surfaced as an `invalid` entry
    rather than being fatal.
  - **The service owns the clock.** `CronScheduler`
    (`services/transport-service/src/cron/scheduler.ts`) scans every
    non-archived Project's task files on a 30 s tick, matches the wall clock, and
    drives `environment.adapter.run()` on the target Session. It is decorated on
    the Fastify instance (`app.cronScheduler`) but started only by `index.ts`'s
    `isMain`; tests and embedders call `tick()`/`fire()` directly. Because it
    re-reads the files every tick, a restart resumes with no recovery step, and
    scheduling survives a cold or dead child.
  - **It shares the one-in-flight-run lock and the record.** A fire takes the
    same `activeRuns` Set the transport route uses, keyed by tenant + Session, so
    a scheduled run and a user run on one Session cannot interleave; a busy target
    is logged `skipped-busy` and dropped. The turn is an ordinary `adapter.run()`
    — it records a `Run`, lands in the Session transcript, and the reply text is
    mirrored into the task log (bounded).
  - **Targeting is Project-scoped, defaulting to the newest Session.** An
    explicit `sessionId` must belong to the firing Project; an omitted one
    resolves to that Project's newest non-archived Session. No target is logged
    `error` (`target session not found`).
  - **The dsh plugin is the authoring surface only.**
    `packages/transport-dsh/src/cron-plugin.ts` gives the agent
    `schedule_create` / `schedule_list` / `schedule_delete` /
    `schedule_set_enabled`, a `/cron` command and one `systemPrompt` section, all
    reading and writing the same task files in the child's cwd. It is mounted by
    a THIRD per-launch patch (`writeCronPatch`) next to the command bridge and
    project plugins, is dependency-free, fails soft, and is inert without Project
    config. It never schedules — the service does.
  - **A restricted 5-field grammar, local time, AND across dom/dow.** The fields
    are minute / hour / day-of-month / month / day-of-week with `*`, ranges,
    lists and steps; no names, no `@` macros, no seconds. Every field is ANDed —
    a documented deviation from POSIX cron's OR between a restricted
    day-of-month and day-of-week. Matching uses the server's local time (`Date`
    getters), and presets (`presetToExpression`) back the UI's hourly / daily /
    weekly choices.
  - **Missed fires are skipped.** The scheduler fires only when the current
    minute matches; a minute the service was down is never caught up, and two
    fires are never coalesced.
- **Consequences**: tasks are inspectable and editable as plain files, and the
  agent authors them directly, but the filename is the only task id and
  `.science-studio/` is now a product-owned namespace inside every Project
  Workspace (shared with the Project Scaffold, docs/adr/0012). The file-is-truth
  model means a hand-edit is picked up on the next tick with no cache to
  invalidate. The local-time and AND semantics will surprise users of POSIX cron:
  a schedule that restricts both day-of-month and day-of-week fires LESS often
  than they expect. A busy target's fire is dropped and only the log records it,
  so a schedule tighter than a Session's run cadence can silently lose fires.
  Hosted mode resolves no service principal, so the scheduler no-ops there (the
  routes still answer; run-now returns `error`), and the service starts it only
  from its own entrypoint. Because the Project Workspace is recycled wholesale on
  delete (docs/adr/0014), cron files go with it and need no separate cleanup.
