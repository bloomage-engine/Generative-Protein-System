# Project/Session lifecycle: rename, reversible archive, irreversible delete

The record layer (ADR-0007) modeled `Project`/`Session`/`Run` with a single
lifecycle verb on Projects — `archive` — and explicitly deferred delete ("No
delete in v1; archiving a Project is a flag; cascade delete is deferred"). The
workbench now needs the full lifecycle for **both** Projects and Sessions:
rename, hide (with a way back), and remove (with the files still safe on disk).
The two hiding intents are different and must not collapse into one flag.

We add four capabilities.

**Rename is an in-place field update.** A Project's `id` names its workspace
directory and is immutable (ADR-0006), so a rename writes `Project.name` only,
never the id and never the directory. A Session's display name is its `title`.
Neither touches the record's identity.

**Archive is a reversible hide.** `Project.archivedAt` already exists; `Session`
gains the same optional field. An archived row is excluded from the default
listing (`listProjects`/`listSessions`, with the existing
`includeArchived` opt-in) and reappears when the flag is cleared. Nothing on disk
moves.

**Delete is irreversible from the UI.** The record rows are removed — a Project
cascades its Sessions and their Runs, a Session cascades its Runs — and, for a
Project, its Project Workspace directory is moved to a **recycle bin**: a sibling
`.recycle/<id>-<timestamp>/` under `PROJECT_ROOT`. The user is told the files
are deleted; the recycle bin is a filesystem safety net, not a product feature.
There is no restore endpoint or UI.

**The default Project is immutable.** The auto-ensured bootstrap row
(`project-default` unless `PROJECT_ID` overrides it, ADR-0007) is the fallback
every unscoped request lands on, so it can be neither renamed, archived, nor
deleted. Its Sessions remain fully manageable.

Two seams carry the delete honestly instead of the service reaching around
them:

- `Workspace` gains an **optional** `recycle(): Promise<void>`. `FsWorkspace`
  moves its root (and a distinct agent root) into the sibling `.recycle/`; a
  deployment with no filesystem surface (null workspace) or a fleet cell (the
  enterprise module) implements it its own way. The route calls
  `workspace.recycle?.()`.
- `EnvironmentProvider` gains an **optional**
  `release(principal, projectId)`: the single-user provider evicts that
  Project's cached environment, so a Project later recreated under the same id
  cannot reuse an adapter (and, for dsh, a harness child) bound to the directory
  that was just moved.

**Scope fallback stays on one path.** When the workbench's active Project or
Session is archived or deleted, the scope is re-resolved with the same rule as a
load — the first active Project and its newest Session — and committed through
`setScope`, which moves the store, the remembered scope and the URL together
(ADR-0009). With no active Project left, the workbench shows the Projects pane.

- **Status**: accepted
- **Considered options**:
  - *Archive only (no delete)* — keeps ADR-0007's one verb, but "remove this and
    its files" is a real intent archive cannot express; it was deferred for lack
    of a caller, and the management UI is that caller.
  - *Soft-delete flag for delete* — the UI offers no restore, so a deleted row
    would live forever behind a filter on every list while its workspace path
    dangles; a real row removal plus a `drop` tombstone is simpler and honest.
  - *Delete the default Project too* — rejected: the "no Project named" path and
    the auto-ensured fallback (ADR-0007) depend on it.
  - *Service-level filesystem move from `PROJECT_ROOT`* — rejected: it reaches
    around the `Workspace` seam, so the hosted/fleet deployment could not honour
    it. The recycle must be a seam capability.
  - *Server-side trash with a restore API* — deferred: v1's recycle bin is a
    filesystem safety net, and the UI deliberately has no restore for delete.
- **Consequences**: `Session` gains `archivedAt`; `RecordStore` gains
  `updateProject`/`unarchiveProject`/`deleteProject`,
  `updateSession`/`archiveSession`/`unarchiveSession`/`deleteSession`, and
  `listSessions(projectId, { includeArchived })`. The JSONL log gains a
  `{ t: "drop", table, id }` row (the loader deletes, compaction drops it) so a
  delete is durable. `Workspace.recycle?()` and
  `EnvironmentProvider.release?()` are optional, so existing implementers
  (`NullWorkspace`, the in-memory provider, the contract-tests suites) stay
  valid. Delete/rename/unarchive are exposed as POST action subpaths
  (`/delete`, `/rename`, `/unarchive`) beside the existing `/archive`, so the
  web proxy stays GET/POST. `Run.projectId` (ADR-0007) is what makes the Project
  cascade a direct query.
