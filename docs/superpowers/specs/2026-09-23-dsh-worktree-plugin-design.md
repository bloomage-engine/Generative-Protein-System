# Worktrees as a Record-Scoped Environment Dimension

## Summary

Today a Generative Protein System **Project** is 1:1 with one workspace directory
(`<PROJECT_ROOT>/<projectId>/`), one runtime adapter and one harness child whose
cwd is that directory, and every **Session** of the Project shares it
(ADR-0008). Researchers want to run parallel lines of work on the same project
— separate git branches, separate files, separate agent context.

This adds a **Worktree** layer between Project and Session:

```
Project → Worktree → Session
```

A Worktree is a first-class record entity and a git worktree of the Project's
repository. The Project root itself is the **main** worktree (branch `main`);
linked worktrees are nested checkouts under `<PROJECT_ROOT>/<projectId>/.worktrees/<id>/`.
Each Worktree is its own environment dimension: it gets its own `FsWorkspace`,
its own dsh adapter and harness child (cwd = the worktree directory), and its
own set of Sessions. **The service owns all git operations** (spawning the
system `git` binary, mirroring the HPC SSH precedent, ADR-0024); a new
dependency-free dsh child plugin is a thin tool channel onto the service's
`/api/worktrees*` routes, exactly like `hpc-plugin.ts`.

## Motivation

A research project is rarely one line of inquiry. A researcher wants to try two
model families, or a refactor of the analysis pipeline, without one branch's
generated data, checkouts and edits colliding with another's — and without the
agent's conversation context bleeding across experiments. Git worktrees are the
natural unit: a real checkout on its own branch, sharing one object store. The
missing piece is grouping agent Sessions under a worktree, giving each its own
working directory, and making the worktree visible and manageable in the
workbench.

## Scope

**In scope:**

- A new record entity `Worktree` (`id`, `projectId`, `name`, `branch`,
  `createdAt`, `archivedAt?`) and `Session.worktreeId`; store methods, cascade
  rules, an auto-ensured `main` row, and read-time normalization of legacy
  Sessions.
- Generalizing the runtime seam from `projectId` to `(projectId, worktreeId)`:
  `Environment`, `EnvironmentProvider`, `ProjectScope`, and the per-worktree
  `FsWorkspace` construction.
- A service git module (system `git`, no library), lazy repository
  initialization, and the `/api/worktrees*` routes (list/create/rename/
  archive/unarchive/delete) with cascade and environment release.
- A fifth dependency-free dsh child plugin (`worktree-plugin.ts`) registering
  `worktree_list` / `worktree_create` / `worktree_remove` tools, a `/worktree`
  command curated into the cold menu, and a `systemPrompt` section; its launch
  patch writer and adapter wiring.
- Worktree as a first-class workbench scope: store state, the
  `/projects/[projectId]/worktrees/[worktreeId]/sessions/[sessionId]` route,
  scope memory, the Project → Worktree → Session tree, worktree management UI,
  and `worktreeId` on the transport/workspace client requests.
- Tests at every layer, plus a new ADR and revisions to ADR-0007 and ADR-0008.

**Out of scope:**

- Any merge / pull-request / review workflow. Merging branches is git's job,
  done by the researcher or the agent through ordinary git tooling.
- A worktree picker for the agent's own cwd. A child's cwd is fixed at launch;
  the agent cannot migrate itself between worktrees (it can create/list/remove
  them). Switching is a human action in the UI.
- Branch protection, remotes, or pushed branches. Worktrees are local.
- A cap on live worktrees / harness children. Resource cost is the user's to
  manage; the archive action is the release valve.
- Submodules, sparse checkout, or bare-repo layouts.
- Moving an existing Session between worktrees (the assignment is immutable at
  creation, like `Project`/`Session` ownership).

## Design

### 1. Domain model (`packages/record`)

```ts
export interface Worktree {
  id: Id;              // unique within the Project, immutable; "main" is reserved
  projectId: Id;
  name: string;        // display name — the only mutable field
  branch: string;      // the git branch this worktree checks out
  createdAt: string;
  archivedAt?: string; // reversible archive, same semantics as Project/Session
}
```

- **Path is derived, not stored.** `worktreeRelPath(id)` is `""` for `main` and
  `posix.join(".worktrees", id)` otherwise. Storing it would duplicate the
  disk layout in the record and invite drift; the same reasoning that makes a
  Project id name its directory (ADR-0007). `branch` **is** stored because it
  cannot be derived from `id` (`exp/foo` vs `foo`).
- **`Session.worktreeId: Id`** is required. `RecordDirectory.resolveOrCreateSession`
  stamps it on first use. A legacy persisted Session with no `worktreeId`
  decodes as `main` — no one-time rewrite migration; old conversations simply
  belong to `main`.
- **`main` is auto-ensured.** `RecordDirectory.ensureWorktree(projectId)`
  creates the `main` row the way `ensureProject` ensures `project-default`; any
  worktree-touching path calls it first, so `main` always exists.
- **Store methods** (`RecordStore`): `addWorktree`, `getWorktree`,
  `listWorktrees(projectId, opts?)`, `updateWorktree(id, { name })`,
  `archiveWorktree`, `unarchiveWorktree`, `deleteWorktree`.
- **Cascade.** `deleteProject` cascades Worktrees; `deleteWorktree` cascades
  its Sessions and Runs (aligning with the Project delete rule, ADR-0014).
  Archive is a reversible flag; listings exclude archived rows unless
  `?includeArchived=1`.
- **Id minting.** A worktree id is the slug of its name (reusing
  `directory.ts`'s slug), suffixed on collision; `main` is reserved. The
  bootstrap `main` worktree cannot be renamed, archived, or deleted (403,
  mirroring `project-default`).

### 2. Environment and scope seam (`packages/transport`)

The environment key grows a worktree dimension; every other semantic (cache,
in-flight de-duplication, release-equals-teardown) is reused unchanged.

```ts
export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  readonly projectId: Id;
  readonly worktreeId: Id;                                   // new
}

export interface EnvironmentProvider {
  acquire(principal: Principal, projectId: Id, worktreeId: Id): Promise<Environment>;
  release?(principal: Principal, projectId: Id, worktreeId?: Id): Promise<void>; // omitted ⇒ all of the Project
  dispose(principal: Principal): Promise<void>;
}
```

- `LocalEnvironmentProvider` (kit) keys its cache and `inflight` map by
  `${projectId}\u0000${worktreeId}`; `environmentFor(projectId, worktreeId)`.
  `release(principal, projectId)` without a worktree releases every child of
  the Project. This is what makes "delete a worktree ⇒ kill that child" a
  one-line call.
- `ProjectScope` (`services/transport-service/src/project-scope.ts`) gains
  `worktreeId`. The claim rule is unchanged (query first, then body) with a new
  `worktreeId` key defaulting to `"main"`. `acquire` calls
  `directory.requireWorktree(projectId, worktreeId)`: an unknown worktree is
  **never auto-created** (creation runs git and is an explicit action) — it is a
  404/400. `sessionOf` writes the `worktreeId` onto a first-use Session.
  Clients that claim nothing (the examples) land on `main`; the web app always
  sends a real id.
- **Workspace construction** (`composition.ts`):

```ts
const rel   = worktreeRelPath(worktreeId);
const host  = join(PROJECT_ROOT, projectId, rel);        // "" rel ⇒ project root
const agent = join(PROJECT_AGENT_ROOT ?? PROJECT_ROOT, projectId, rel);
return new FsWorkspace(host, {
  agentRoot: agent,
  hiddenEntries: [".git", ".worktrees"],                  // new option
});
```

- `hiddenEntries` is a new optional `FsWorkspaceOptions` field: entries with
  those names are omitted from `list` results. It stops the `main` worktree's
  tree from recursively listing every worktree under `.worktrees/` and hides
  `.git`. It affects only the seam's listing (the UI browser); the dsh child
  uses its own filesystem, and `.gps/cron` stays visible.
- **Runtime context.** `RuntimeInitOptions` gains
  `worktree?: { id: string; name: string; branch: string; root: string }`.
  Composition fills it from the record row plus the worktree host path for the
  child plugin (section 4). The adapter still derives its cwd solely from
  `workspace.toAgentPath("")`; no cwd logic changes.
- **Project delete.** The existing `workspace.recycle?.()` on the `main`
  workspace moves the whole `<PROJECT_ROOT>/<projectId>/` (nested `.worktrees`
  included) to `.recycle/`; the route then `release(principal, projectId)`
  (all worktrees) and `dispose(principal)`.
- **Worktree archive** releases that worktree's environment (freeing its
  child) while keeping the directory; the next use lazily re-acquires it.

### 3. Service: git module and `/api/worktrees*` routes

**`services/transport-service/src/worktree/git.ts` — a pure git client.** It
spawns the system `git` binary via `child_process` (there is no git library in
the product, mirroring `hpc/ssh.ts`; `GIT_BINARY` overrides the default PATH
binary, and a missing binary degrades the surface to a friendly 503). Pure,
Node-testable against a temp repo:

- `isRepo(dir)`, `init(dir)`, `ensureGitignore(dir, entries)`,
  `currentBranch(worktreeDir)`,
  `worktreeAdd({ repoDir, path, branch, base, createBranch })`,
  `worktreeRemove({ repoDir, path, force })`, `worktreeList(repoDir)`.

Git stderr is carried through on the error object.

**Lazy initialization** — `ensureRepo(hostProjectRoot)`, idempotent:

1. If not a repository: `git init -b main`; write `.gitignore` containing
   `.worktrees/` and `.gps/`; `git add -A`; commit an initial
   commit with a local identity (`-c user.name="Generative Protein System" -c
   user.email="gps@localhost"`) so it never depends on the
   machine's global git config.
2. `directory.ensureWorktree(projectId)` ensures the `main` row (record only,
   no git).

Only **creating a worktree** triggers initialization. Listing ensures the
`main` row and nothing more — looking at the panel never creates a repository.

**Routes** (`services/transport-service/src/worktree/routes.ts`), shaped like
the project routes:

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/worktrees?projectId=&includeArchived=` | Record list, each row decorated with on-disk state (exists, current branch) |
| POST | `/api/worktrees` | `{ projectId, name, branch?, base? }`: ensureRepo → mint id → `git worktree add -b <branch> <path> <base>` → write record row |
| POST | `/api/worktrees/:id/rename` | `name` only (id and branch are immutable) |
| POST | `/api/worktrees/:id/archive\|unarchive` | Flip the record flag; archive also releases the environment |
| POST | `/api/worktrees/:id/delete` | Release child → `git worktree remove --force` → recycle any remainder to `.recycle` → cascade-delete the record |

- `projectId` resolves through the same `ProjectScopes` claim.
- **Ordering:** create is git-then-record, so a git failure leaves no row; if
  the record write fails, the service compensates with a best-effort
  `git worktree remove`. The service is the single writer, so this rollback is
  sound.
- `main`'s rename/archive/delete return 403; a create may not use the id
  `main`.
- Status codes: 404 unknown project/worktree, 409 branch already checked out (a
  worktree cannot check out a branch another worktree already holds — git
  enforces this), 400 invalid name/branch, 502 git failure (stderr surfaced),
  503 no `git`. Names need not be unique; a colliding id is silently suffixed,
  never a 409.
- Defaults: `base = "main"` and `branch =` the minted id, so a new worktree
  takes a fresh branch off `main` (defaulting `branch` to `main` would be
  impossible — git forbids two worktrees on one branch). An existing branch can
  instead be checked out with `createBranch = false`.

**Web proxy.** `apps/web/app/api/worktrees/[[...path]]/route.ts` relays through
the existing `lib/service-proxy.ts` (no `fetch`, forwarded auth, verbatim
status/body).

### 4. dsh side: `worktree-plugin.ts` and its launch patch

A fifth dependency-free child plugin,
`packages/transport-dsh/src/worktree-plugin.ts`, follows `hpc-plugin.ts`: it
only fetches the service, and never touches git itself.

- `name = "gps-worktree"`, `inject = ["commands", "tools",
  "systemPrompt"]`, inert when `config.project` is absent.
- Tools (all against `GPS_SERVICE_URL` / the patch's `service`, the
  same resolution `hpc-plugin.ts` uses):
  - `worktree_list()` — list the Project's worktrees and mark the current one.
  - `worktree_create({ name, branch?, base? })` — create a worktree. It does
    **not** change the agent's own cwd.
  - `worktree_remove({ worktree })` — delete; the destructive semantics live in
    the tool description.
- A `/worktree` command lists worktrees and marks the current one, **curated
  into the cold-start menu** (as `/project` and `/cron` are).
- A `systemPrompt` section states plainly: *"You are working in worktree
  `<name>` (branch `<branch>`), root `<root>`. Other worktrees are independent
  checkouts of the same repository under `.worktrees/`. You can create, list,
  and remove worktrees, but you cannot switch your own working directory — to
  work in another worktree, the researcher opens it in the workbench."* This is
  load-bearing: without it the model assumes it can migrate itself.
- Wiring mirrors project/cron/hpc: a `writeWorktreePatch` in `bridge.ts`
  (patch id `gps-worktree`, `config = { project, worktree, root:
  cwd, service? }`) and an `adapter.ts` branch mounting it only when
  `opts.project` exists, with the worktree context from
  `RuntimeInitOptions.worktree` (falling back to `main` when absent).
- Child-plugin rules hold: no `@deepseek-ai/*` imports, never write stdout,
  `apply` fails soft. `RuntimeCapabilities` needs no new field.

### 5. Workbench: worktree as a first-class scope

- **Store** (`studio-store.ts`): add `worktrees` (the active Project's list) and
  `activeWorktreeId`. `setScope(projectId, worktreeId, sessionId)` is the only
  way the scope changes and moves store, memory, and URL together. A worktree
  switch clears `tabs` (like a Project switch). (The status bar does not yet show
  the current branch — a branch/worktree readout there is a follow-up.)
- **URL**: `/projects/[projectId]/worktrees/[worktreeId]/sessions/[sessionId]`;
  home `/` resolves the remembered scope. `StudioHost` keys `SessionView` by
  `projectId/worktreeId/sessionId`, so any scope change remounts the runtime.
- **Scope memory** (ADR-0009): the blob grows to
  `{ lastProjectId, worktrees, sessions }` (worktrees and sessions keyed per
  Project). Resolution stays
  "URL claim if the record lists it, else remembered Project, else first
  Project"; a worktree claim must be in the Project's worktree list, else it
  falls back to `main`. Only an authoritative "no" prunes; a fetch failure
  leaves the memory alone. The URL is still mirrored with
  `history.replaceState`, never navigated.
- **Projects pane**: a `Project → Worktree → Session` tree. Single-click a
  Project expands its worktrees; single-click a worktree selects it (browsing
  that worktree's files, no Session required); double-click a Session opens it
  (preserving the existing expand-vs-open convention). A worktree row's menu
  offers create / rename / archive / delete; delete warns that it cascades the
  worktree's Sessions. Archiving or deleting the **active** worktree moves the
  scope back to `main` (and clears the open tabs).
- **Client requests carry `worktreeId`** (query first; the service claim
  defaults it to `main`, keeping backward compatibility):
  - `useTransport` (mount probe and standing watch) plus the web app's
    `/api/transport/watch` query whitelist and the `commands` hop;
  - `useWorkspaceRoot` / `useWorkspaceBrowser` / `useWorkspaceFile` /
    `workspaceFileUrl` — the file tree and previews show the **active
    worktree's** workspace, and the shared root listing is keyed by
    `(api, projectId, worktreeId)`;
  - Session creation: `POST /api/projects/:id/sessions` gains `worktreeId`
    (default `main`), chosen in the UI.
- **Project-level routes** (cron, HPC binding, subagent listings) keep using
  `acquireProject` or the `main` default and are unaffected.

## Data flow: one turn

1. The workbench has scope `(project, worktree, session)`; `useTransport` sends
   the run with `projectId`, `worktreeId`, `threadId` in the query.
2. The service `ProjectScopes.sessionOf` resolves the Project, requires the
   worktree row, acquires the `(project, worktree)` environment (spawning that
   worktree's harness child on first use), and maps the session key.
3. The adapter's child runs with cwd = the worktree directory; its
   `worktree-plugin` systemPrompt names the worktree.
4. Workspace routes for the same scope serve that worktree's files.

## Error handling

- An unknown `worktreeId` is a 404/400, never an implicit create.
- A git failure surfaces git's stderr verbatim as a 502; the client keeps its
  last good list (per the client-failure policy, ADR-0021).
- A missing `git` binary degrades the worktree surface to a 503 with friendly
  copy, like an unavailable workspace.
- `main` is protected (403) from destructive operations.
- Deleting a worktree with Sessions cascades; the UI requires confirmation
  naming that consequence.

## Migration and compatibility

- No destructive migration: a Session missing `worktreeId` reads as `main`; a
  Project whose workspace is not a repository stays a non-repository until the
  first worktree creation, which lazily initializes it.
- The `EnvironmentProvider` signature change is a **seam change**: the
  `contract-tests` suites and every `EnvironmentProvider` implementation
  (including the private enterprise module) must adopt `(projectId,
  worktreeId)`. `./seams` remains the contract-only entry.
- Existing project-level routes keep working through the `main` default.

## Testing

- **record:** Worktree CRUD; `main` auto-ensure; cascade delete of Sessions and
  Runs; legacy Session normalization to `main`; 403 protection of `main`.
- **seam/kit:** `LocalEnvironmentProvider` keyed by `(project, worktree)` with
  cache, in-flight de-dup, single-worktree release and whole-Project release;
  `ProjectScope` claim, `main` default, and unknown-worktree rejection.
- **git client:** on a temp repo — init (gitignore entries, initial commit,
  branch `main`), add/list/remove, nested paths, stderr propagation on failure.
- **routes:** create/list/delete; lazy init (a list does not create a repo);
  `main` protection (403); cascade; 409/400/404/502.
- **dsh:** patch writer output; the plugin's tool set and `/worktree` cold-menu
  entry on a fake context; tools against a scripted fetch.
- **web e2e:** worktree-aware scope resolution and restore; no socket leak on
  worktree switching (extending `scope-switch-sockets`); tab state; the file
  tree fetching by worktree.
- `npm run build` (the real type gate) and `npm run test` green.

## Documentation

- New ADR `docs/adr/0025-worktree-is-a-record-scoped-environment-dimension.md`.
- Revise ADR-0007 (the v1 vocabulary becomes `Project → Worktree → Session →
  Run`) and ADR-0008 (per-Project provisioning becomes per-worktree).
- Update `AGENTS.md` (the project/workspace section and the dsh plugin list)
  and `CONTEXT.md` (Worktree vocabulary).
