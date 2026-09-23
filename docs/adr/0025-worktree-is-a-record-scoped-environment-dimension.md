# A Worktree is a record-scoped environment dimension

A Science Studio **Project** used to be 1:1 with one workspace directory
(`<PROJECT_ROOT>/<projectId>/`), one runtime adapter, and one harness child whose
cwd is that directory — every Session of the Project shared it (docs/adr/0006,
0008). A research project is rarely one line of inquiry: a researcher wants to
run two model families or refactor the analysis pipeline without one branch's
checkouts, generated data and edits colliding with another's, and without the
agent's conversation context bleeding across experiments. A new **Worktree**
layer sits between Project and Session:

```
Project → Worktree → Session → Run
```

A Worktree is a first-class record entity AND a git worktree of the Project's
repository. The Project root itself is the reserved **`main`** worktree; linked
worktrees are nested checkouts under `<PROJECT_ROOT>/<projectId>/.worktrees/<id>/`.
Each Worktree is its own environment dimension — its own `FsWorkspace`, its own
adapter and harness child, and its own set of Sessions. **The service owns every
git operation**, mirroring the HPC SSH precedent (docs/adr/0024); the agent-side
tool plugin and the workbench scope are separate plans over this backend.

- **Status**: accepted (refines the vocabulary of docs/adr/0007 and the
  per-Project provisioning of docs/adr/0008)
- **Context**: the product needed parallel lines of work on one project, and git
  worktrees are the natural unit — a real checkout on its own branch sharing one
  object store. *Considered and rejected*: one Project per experiment — it works
  but every experiment re-clones the record, its Sessions and its workspace, and
  a manager's Project-level rollup fragments. *Considered and rejected*: a branch
  switch inside the single workspace — mutating a directory under a live harness
  child invalidates the child's cwd, and two Sessions that want different
  branches cannot coexist. *Considered and rejected*: a `branch` field on Session
  with no directory of its own — a Session cannot be isolated by a label;
  isolation is a filesystem fact.
- **Decisions**:
  - **`Worktree` is a record entity.** `{ id, projectId, name, branch, createdAt,
    archivedAt? }`: `id` is unique within the Project (immutable, `main`
    reserved), `name` is the only mutable field, `branch` is stored because it
    cannot be derived from `id` (`exp/foo` vs `foo`). The store keys worktree
    rows by `(projectId, id)` — every Project has its own `main`, so a bare id
    would shadow across Projects. `Session.worktreeId?: Id` is OPTIONAL with
    `sessionWorktreeId()` normalizing an absent value (a legacy row written
    before worktrees existed) to `main`, so no one-time rewrite migration is
    needed; old conversations simply belong to `main`.
  - **The Project root IS the `main` worktree; its path is derived, never
    stored.** `worktreeRelPath(id)` is `""` for `main` and
    `posix.join(".worktrees", id)` otherwise. Storing the path would duplicate
    the disk layout in the record and invite drift — the same reasoning that
    makes a Project id name its directory (docs/adr/0007). `main` is
    auto-ensured the way `project-default` is; any worktree-touching path ensures
    it first.
  - **The environment is keyed by `(projectId, worktreeId)`.** `Environment`
    carries both ids, `EnvironmentProvider.acquire/release` take both (release
    without a worktree releases every child of the Project), and
    `LocalEnvironmentProvider` caches per composite key with the same in-flight
    de-duplication as before. `ProjectScope` gains `worktreeId`; the claim rule is
    unchanged (query first, then body) with a new `worktreeId` key defaulting to
    `"main"`, and `acquire` calls `requireWorktree` so an unknown worktree is a
    404, **never** auto-created (creation runs git and is an explicit act). This
    is what makes "delete/archive a worktree ⇒ kill that child" one call.
  - **One harness child per live worktree.** `composition.localWorkspace(env,
    projectId, worktreeId)` joins the derived rel path onto `PROJECT_ROOT` /
    `PROJECT_AGENT_ROOT`, and `FsWorkspace` hides `.git` and `.worktrees/` so the
    `main` tree does not recurse into every linked checkout. `RuntimeInitOptions`
    gains a `worktree` context (id, name, branch, agent-side root); the adapter
    still derives its cwd solely from `workspace.toAgentPath("")`, so no cwd
    logic changes — only which workspace a child is initialized with.
  - **The service owns git, via the system binary.** `worktree/git.ts` spawns the
    system `git` (no library), mirroring `hpc/ssh.ts`; `GIT_BINARY` overrides the
    default. The repository is initialized LAZILY — only creating a worktree runs
    `git init -b main`, writes a `.gitignore` (`.worktrees/`,
    `.science-studio/`) and commits with a local identity; a list ensures the
    `main` row and nothing more, so looking at a panel never touches the disk.
    Create is git-then-record (a git failure leaves no row; a failed record write
    compensates with a best-effort `worktree remove` and branch delete), the
    service being the single writer.
  - **`/api/worktrees*` is the surface, `main` is protected.** List/create/
    rename/archive/unarchive/delete under the same `ProjectScopes` claim; `main`
    cannot be renamed, archived or deleted (403). Delete releases the child,
    removes the linked checkout, deletes the branch (so the same name is
    creatable again), recycles any remainder to `.recycle/`, then cascade-deletes
    the record rows (its Sessions and their Runs), mirroring the Project delete
    rule (docs/adr/0014). Archive is a reversible flag AND releases that
    worktree's cached environment while keeping the directory; the next use
    lazily re-acquires it.
- **Consequences**: the record vocabulary is `Project → Worktree → Session →
  Run`; a Project's shared workspace is now reachable only through its `main`
  worktree, and the workspace/transport routes carry a `worktreeId` claim
  (`main` by default, so existing project-level clients keep working). The
  `EnvironmentProvider` signature change is a **seam change**: the shared
  `contract-tests` suites and every implementation (including the private
  enterprise module) adopt `(projectId, worktreeId)`. A Session's worktree
  assignment is immutable at creation (like Project/Session ownership); moving a
  Session between worktrees is out of scope. There is no merge/review workflow, no
  remote/branch protection and no cap on live worktrees — resource cost is the
  researcher's to manage, and archive is the release valve. A deployment whose
  workspace directories are not repositories stays a non-repository until the
  first worktree creation lazily initializes it. The dsh `worktree_*` tool plugin
  and the workbench's Worktree scope are the next plans; they add no record or
  environment vocabulary beyond this ADR.
