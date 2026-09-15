# Project is the workspace and sharing unit

The record layer had a `Project` with no relations and a single global
workspace root, while the design doc (research-agent-framework.md §14.3) made the
**Session** the workspace partition unit (`<root>/sessions/<sessionKey>/`). We
reverse that: **`Project` is the container that owns one Project Workspace and
N Sessions**, and everything its Sessions produce — files, and (via the record
layer) runs — is shared at the Project level. A Session belongs to a Project
directly; `Study` is demoted out of v1 (see ADR-0007).

**What a Project Workspace is.** A `Workspace` (the existing file-service seam,
`packages/transport/src/workspace.ts`) rooted at a per-project directory on the
host, `<PROJECT_ROOT>/<projectId>/`. The project id is minted by the server as a
filesystem-safe slug, so the directory name *is* the project id. Sessions of one
Project share this single root flatly: the browser roots at the project root, and
a workspace-relative path maps to the agent side as
`<PROJECT_AGENT_ROOT>/<projectId>/<rel>`. There are no per-Session
subdirectories in v1 — sharing the exact same files is the point, and the
collision/leak concerns §14.3 guarded against are precisely what Project-level
sharing wants.

**Provisioning is project-scoped for the FILE SURFACE only.** The workspace can no
longer arrive once per deployment: `EnvironmentProvider.acquire(principal,
projectId)` returns a cached per-Project `{ adapter, workspace }`. The **adapter
stays one per user** — a single instance (one `SessionRuntime` map) serves every
Project — because building a distinct runtime instance per Project would need a
project-aware launch surface that the `RuntimeBinding` seam does not have, and v1
has no use for one. The consequence is explicit: the agent's cwd is the
deployment's **agent root**, not the project root, so for **both** runtimes
Project isolation is a path-mapping + reference convention, not an enforced
boundary. (This also settles the §14.3 asymmetry: the openclaw cell's fixed cwd
and the dsh child's single cwd now have the same status.)
`capabilities.perSessionCwd` keeps its meaning as "the host, not the runtime, sets
the child's cwd" — one cwd per adapter — and is no longer read as per-Project.

> **Superseded by docs/adr/0008.** Everything in the paragraph above about the
> adapter being shared across Projects — "the adapter stays one per user", the
> agent cwd being the deployment's agent root, and the "one cwd per adapter"
> reading of `perSessionCwd` — was wrong in practice: an adapter's
> workspace-derived launch surface is fixed at `init`, so one shared adapter can
> only serve the default Project, and every other Project's agent kept working in
> `project-default`. Provisioning is now **per Project**: one adapter (and, for
> dsh, one harness child) per Project, each initialized with that Project's
> workspace. `perSessionCwd` keeps its meaning; it just no longer implies one cwd
> per deployment.

**Explicit no-s.** No per-Session partition in v1 (a later convention may add one
if intermediates start colliding). No adapter (and so no child cwd) per Project —
one adapter serves the user; project isolation for the AGENT is a convention for
every runtime. *(Superseded by docs/adr/0008: the provider builds one adapter per
Project.)* No hard jail for **openclaw**: its gateway cell exposes one fixed
`OPENCLAW_WORKSPACE_DIR`, so the agent can reach outside a project directory — the
same openclaw/dsh symmetry the revised §14.3 records. No workspace
root *inside* the record; the directory is a deployment artifact and the record
is its authority.

- **Status**: accepted (supersedes research-agent-framework.md §14.3); the
  one-adapter-per-user clause is superseded by docs/adr/0008
- **Considered options**:
  - *One adapter + binding per Project* (a real per-project cwd: one dsh harness
    child per Project) — rejected for v1: it needs a project-aware launch surface
    the `RuntimeBinding` seam does not expose, and it multiplies harness children
    and gateway connections per Project for an isolation the file surface already
    gives by convention. *(Adopted in docs/adr/0008: the launch surface needed no
    widening — the cwd already comes from the `Workspace` the adapter is
    initialized with — and one adapter per Project is the price of the agent
    working in the Project that asked.)*
  - *Keep Session as the partition unit and share upward* (`sessions/<key>/` with
    a browsable project root above it) — preserves §14.3's isolation and needs no
    provisioning change, but makes "share across Sessions" a derived view over
    directories that still collide and leak by default. Rejected: it inverts the
    requirement (Project-level sharing) into an afterthought.
  - *Per-Session subdirectories plus a shared subdirectory* — more structure
    (e.g. `shared/` + `sessions/<id>/`), but invents a directory contract before
    any Session needs one. Rejected as premature; the flat root can grow the
    convention later without breaking paths.
  - *A cell/sandbox per Project* — true filesystem isolation per Project, but the
    provisioning cost and fleet churn per Project are far too high (the same
    reason §14.3 rejected a cell per Session).
- **Consequences**: `WORKSPACE_ROOT`/`WORKSPACE_AGENT_ROOT` are replaced by
  `PROJECT_ROOT`/`PROJECT_AGENT_ROOT` (the former parent-of-projects); an
  existing install migrates by moving its files under
  `<PROJECT_ROOT>/project-default/`, because a default project is auto-ensured so
  a configured root still "just works". The workspace HTTP routes take
  `?project=` instead of `?session=` (omitted → the default Project), and the
  client hooks (`useWorkspaceBrowser`/`useWorkspaceFile`/`useWorkspaceMentions`)
  follow. The service acquires the environment by Project, then maps the claimed
  `threadId` through the adapter's `resolveSessionKey` and resolves the Session,
  so the run lock and file surface agree on one Project.
