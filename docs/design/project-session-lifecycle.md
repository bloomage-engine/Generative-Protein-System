# Project/Session lifecycle — implementation design

Companion to ADR-0014. Describes the surfaces this feature adds; the ADR owns the
decision and its rationale.

## Record store (`@gps/record`)

New/changed `RecordStore` members (implemented by both the in-memory and JSONL
stores and pinned by `test/record-store.test.ts`):

```
listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>   // exists
updateProject(id, patch: { name: string }): Promise<Project>
archiveProject(id, archivedAt): Promise<Project>                          // exists
unarchiveProject(id): Promise<Project>
deleteProject(id): Promise<void>            // cascades Sessions + their Runs

listSessions(projectId, opts?: { includeArchived?: boolean }): Promise<Session[]>
updateSession(id, patch: { title: string }): Promise<Session>
archiveSession(id, archivedAt): Promise<Session>
unarchiveSession(id): Promise<Session>
deleteSession(id): Promise<void>            // cascades its Runs
```

`Session` gains `archivedAt?: string`. A rename bumps `updatedAt`; an archive
sets `archivedAt` and leaves the other fields.

The JSONL store appends a `{ t: "drop", table: "project" | "session" | "run",
id }` row for every removed row (cascades expand to multiple drops). The loader
applies a drop by deleting the key; compaction writes only live tables.

## Workspace / environment seams (`@gps/transport`)

- `Workspace.recycle?(): Promise<void>` — optional. `FsWorkspace` moves its root
  to `<dirname(root)>/.recycle/<basename(root)>-<timestamp>/`, and a distinct
  `agentRoot` to the same bin; `NullWorkspace` does not implement it.
- `EnvironmentProvider.release?(principal, projectId): Promise<void>` — optional;
  `LocalEnvironmentProvider` drops the cached environment (and any pending
  acquire) for that Project.

## Service (`@gps/transport-service`)

`RecordDirectory` gains `renameProject / unarchiveProject / deleteProject` and
`renameSession / archiveSession / unarchiveSession / deleteSession`, plus the
`includeArchived` pass-through on `listSessions`.

Routes (all POST, GET/POST-only web proxy unchanged):

```
GET  /api/projects                       -> { projects, defaultProjectId }
POST /api/projects/:id/rename            { name }        403 if default
POST /api/projects/:id/archive                            403 if default
POST /api/projects/:id/unarchive
POST /api/projects/:id/delete            recycle + release; 403 if default
GET  /api/projects/:id/sessions?includeArchived=1
POST /api/projects/:id/sessions/:sid/rename     { title }
POST /api/projects/:id/sessions/:sid/archive
POST /api/projects/:id/sessions/:sid/unarchive
POST /api/projects/:id/sessions/:sid/delete
```

`defaultProjectId` is `backend.recordDefaults?.projectId ?? DEFAULT_RECORD_DEFAULTS.projectId`.
A rename with an empty/whitespace name is 400; unknown ids are 404.

Delete order: resolve the record's Project row, rename its workspace into the
recycle bin, remove the record rows, then release the environment. A workspace
with no surface (null) is a no-op, not an error.

## Client (`@gps/transport-client`)

`renameProject`, `archiveProject`, `unarchiveProject`, `deleteProject`,
`renameSession`, `archiveSession`, `unarchiveSession`, `deleteSession`; plus
`fetchProjectsOverview(api): Promise<{ projects; defaultProjectId }>` and an
`includeArchived` option on `fetchProjectSessions`. `fetchProjects` keeps its
`Project[]` shape.

## Workbench (`apps/web`)

- Each Project/Session row shows a hover `⋯` menu (DropdownMenu): Rename /
  Archive / Delete. The default Project's menu hides all three destructive
  entries (only nothing, since rename is also disallowed).
- Rename is an inline `Input`; Enter/blur commits, Escape cancels.
- Delete opens a `Dialog` that states all history files will be deleted.
- The panel header gets an **Archive** toggle. The archive view is re-listed on
  every open (archiving happens in the other view, so a cached list is stale) and
  groups by Project: archived Projects (expanded to their Sessions) and active
  Projects that have archived Sessions (expanded to only those Sessions), each
  archived row with **Restore** and a permanent **Delete** (same irreversible
  delete as the main list, behind the same confirm dialog). Archived Sessions are
  fetched with `includeArchived=1` on expansion.
- After any mutation the store refreshes `projects` / `panelSessions` /
  `sessions`. If the mutation touched the active scope, `setScope` is called
  with the fallback — first active Project, newest Session, else `null` (which
  shows the Projects pane). `pruneScopeMemory` already drops archived Projects
  because the default listing omits them.

## Tests

| Layer | File | What |
|---|---|---|
| record | `packages/record/test/record-store.test.ts` | rename/archive/unarchive/delete, cascade, JSONL restart with drops |
| workspace | `packages/workspace/test/*` | `recycle()` moves the root; null has no method |
| service | `services/transport-service/test/projects.test.ts` | each route, default-project 403, recycle called, session cascade |
| client | `packages/transport-client/test/*` | request shapes for the new helpers |
| web | `apps/web/test/scope-memory.test.mjs` + panel suite | fallback/prune table; panel row-menu + archive view invariants |
