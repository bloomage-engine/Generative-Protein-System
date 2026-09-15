# Runtime provisioning is per Project

ADR-0006 made the Project the workspace unit and the environment provider
project-scoped, but kept **one adapter per user**: the composition root built a
single adapter at startup, initialized it with the *default* Project's workspace,
and handed that same instance to every Project's environment. Everything the
adapter derives from its workspace was therefore frozen on `project-default`.

That is not a cosmetic mismatch. An adapter's workspace-derived launch surface is
fixed at `init`:

- dsh launches its harness child with `cwd = workspace.toAgentPath("")` — the ONE
  directory the agent reads and writes in, and the directory it records on every
  SDK-created session;
- both runtimes map a workspace attachment through the same object
  (`toAgentPath(relPath)`), so an attachment picked in the Files panel reaches the
  agent as a path under whichever project the adapter was initialized with.

Observed before this ADR: a new Project's Files panel listed
`<PROJECT_ROOT>/<projectId>/` while the agent worked in
`<PROJECT_AGENT_ROOT>/project-default/` — files the agent produced never appeared
in the Project that asked for them, and attachments pointed at the wrong Project's
tree. Switching Projects changed the browser, not the session's directory.

We therefore build **one adapter per Project**: `environmentFor(projectId)` creates
an adapter and initializes it with that Project's own `Workspace`
(`<PROJECT_ROOT>/<projectId>/`, agent side `<PROJECT_AGENT_ROOT>/<projectId>/`),
and `LocalEnvironmentProvider` caches one `{ adapter, workspace }` per Project. A
Project's Sessions share its adapter — and, for dsh, its harness child — while
different Projects never share one.

**This supersedes ADR-0006's "one adapter stays one per user"** and the parts of
`research-agent-framework.md` §4.2/§4.4/§14.3 that repeat it (its rejection of
"one adapter + binding per Project"). The rest of ADR-0006 — Project as the
workspace and sharing unit, the flat per-Project root, `<PROJECT_ROOT>` /
`PROJECT_AGENT_ROOT`, `?project=` on the workspace routes — stands unchanged.

- **Status**: accepted (supersedes the per-user-adapter clause of docs/adr/0006)
- **Considered options**:
  - *Keep one shared adapter and hand the Project's workspace per run* — cannot
    work: dsh's cwd is a property of the spawned child, not of a turn, so a
    project's directory would still have to come from a per-project child; and it
    would push the workspace through every run/attachment call as a new
    parameter for a value the environment already knows.
  - *Keep one shared adapter and re-`init()` it when the Project changes* —
    the environment provider caches per Project, so which Project is "current"
    depends on request interleaving: two Projects' Sessions would flip one
    adapter's cwd back and forth, and each flip would tear down a live harness
    child mid-run.
  - *Per-Project adapters only for runtimes whose cwd follows the workspace*
    (a `capabilities.perSessionCwd` branch) — the core would branch on a runtime
    trait to save a connection for runtimes whose cwd is host-fixed, and
    attachment mapping would still need per-run wiring for the other branch.
    Rejected: one uniform rule is what keeps the composition root runtime-blind.
  - *A cell/sandbox per Project* — the isolation ADR-0006 already rejected on
    cost grounds; still rejected, and still not what this fixes.
- **Consequences**: an adapter exists per **used** Project, built lazily on the
  first request that names it (that request is never blocked by a slow runtime:
  `init` stays fire-and-forget and `run()` awaits readiness). dsh spawns one
  harness child per Project — `DSH_TRANSCRIPT_DIR` is keyed by session id, and
  session ids are unique across Projects, so the mirror stays shared. openclaw
  opens one gateway connection per Project. `capabilities.perSessionCwd` keeps
  its meaning ("the host sets the child's cwd"); it just no longer implies one
  cwd for the whole deployment. Open item: multiple backend connections carry the
  same gateway client id (`cli`) — verified against a live gateway for one
  connection, not yet for several.
