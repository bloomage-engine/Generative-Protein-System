# The v1 record layer is Project → Session → Run, on a file-backed store

> **Vocabulary note (added by ADR-0025):** the v1 record is now
> `Project → Worktree → Session → Run`. A `Worktree` sits between Project and
> Session as a git worktree of the Project's repository; the Project root is the
> reserved `main` worktree and every Session carries a `worktreeId` (an absent
> one normalizes to `main`). Worktrees were added by
> docs/adr/0025; everything else here stands.

The record layer published `Project`/`Study`/`Task`/`Run`/`Artifact`/`Evidence`/
`Conclusion`/`Session`/`AgentBlueprint`, but only `Session` and `Run` were ever
exercised: `Project`, `Task`, `Evidence`, `Conclusion` and `AgentBlueprint` had
no production caller, the `Artifact` path was dead (`RuntimeAdapter.onArtifact`,
its only producer, is never invoked), `Run.taskId` was a lie (it was filled with
the session key), and `Run` itself was write-only — `addRun` had no reader, and
`updateRun` was never called. Meanwhile the store was in-memory only, so
"Project owns Sessions and shares their results" could not survive a restart.

We cut the v1 record layer down to what is actually load-bearing — **`Project →
Session → Run`**, later extended to `Project → Worktree → Session → Run` by
ADR-0025 — and give it a persistence implementation, so the Project/
Session surface of ADR-0006 is real rather than per-process.

**What stays.** `Project` (`createProject`/`getProject`/`listProjects`),
`Session` (`addSession`/`getSession`/`listSessions(projectId)`), and `Run`
(`addRun`/`listRuns(projectId)`) — plus `Id`. `RecordStore` stays in
`@science-studio/record`, which is the **record-seam package**, parallel to
`transport` being the runtime-seam package: both are contracts an out-of-tree
implementer (the private enterprise module) depends on, and neither is renamed by
the other's concerns. The store contract is implemented by an in-memory store
(tests) and a dependency-free **JSONL** store (append log + index rebuilt on
load, compaction on start), which the single-user service uses **by default**
(`RECORD_STORE_PATH`, default `$XDG_DATA_HOME/science-studio/record.jsonl`;
`RECORD_STORE=memory` opts out).

**How a Session is found.** `POST /api/projects/:id/sessions` creates one
explicitly. The transport route also RESOLVES a claimed runtime session key
within a Project and **lazily records** it when it is new: the mount probe and
assistant-ui's local-mint ids must keep converging, so refusing an unknown key
would break every existing client. `projectId` is optional on requests and falls
back to the auto-ensured default Project (`project-default`), which is what keeps
a single-project install working without a picker. Project creation, by contrast,
is always explicit (plus that one bootstrap row).

**Why `Run` stays and earns a read path.** `Run` is the product's atomic
traceable unit — one research turn, with input, output, status, agent, token
usage and timestamps — and it is already produced by every adapter's settle
pipeline. Rather than abandon a write-only ledger, v1 adds the missing reader:
`listRuns(projectId)`, so a Project page shows every turn of every Session in
that Project. `Run` carries a denormalized `projectId` so the rollup is a direct
query and remains correct if a Session is archived.

**Explicit no-s.** No `Study`, `Task`, `Evidence`, `Conclusion` or
`AgentBlueprint` in v1 code — they move to the glossary as *deferred*, not to
"reserved" stubs that never get wired (that is what we are cleaning up). No
`Artifact`: "data-file sharing" is fully served by the shared Project Workspace
(ADR-0006), and the provenance layer arrives with its real producer, not before.
No delete in v1 (archiving a Project is a flag; cascade delete is deferred). No
SQL/Postgres for the OSS store while the entity count is three.

- **Status**: accepted
- **Superseded in part by ADR-0014**: the "No delete in v1" consequence below is
  revised — Projects and Sessions now rename, archive (reversibly) and delete
  (cascading, with a Project Workspace moved to a recycle bin). Everything else
  here stands.
- **Considered options**:
  - *Drop `Run` entirely in v1 (Project/Session only)* — the most consistent
    application of "only what is read", and it would also delete the settle
    pipeline's persistence path. Rejected: `Run` is already being produced, the
    missing piece is one query, and removing then rebuilding the traceable-record
    foundation is more churn than adding its reader.
  - *Keep `Run` write-only* — zero cost, but it is exactly the dead-weight shape
    this decision removes.
  - *Move `RecordStore` into `transport/seams`* so "all seam interfaces live in
    transport" reads literally — rejected: it would put the research-record
    contract inside the runtime boundary package, blurring the separation
    ADR-0002 exists to protect. The rule is corrected to name two seam families
    instead.
  - *`node:sqlite` (built-in) or `better-sqlite3`* — real SQL and transactions,
    but the first needs a Node engine bump plus `@types/node`, the second a
    native dependency. Rejected for now: three entities in a single-user service
    do not justify either, and `RecordStore` keeps SQLite/Postgres swappable
    later.
  - *Postgres for OSS too* — rejected as far too heavy for single-user; it stays
    the enterprise path (research-agent-framework.md §14.5).
- **Consequences**: `Run.taskId` is removed; `Session.studyId` and
  `agentBlueprintId` become `projectId` and `agentId`; `SessionState.studyId`
  becomes `projectId` on the wire. With `Artifact` gone, `RecordStoreLike` and
  `RunSink` collapse to the same single method (`addRun`), and `ArtifactInput`,
  `RuntimeAdapter.onArtifact` and `RecordStoreLike.addArtifact` are deleted. A
  JSONL store's crash semantics are "the last record may be lost, earlier ones
  survive", which the append-only format makes true; `updateRun` is unused and is
  not reintroduced. When the provenance/conclusion overlay is designed, its
  entities return to `record` and to the same store — no interface change.
