# A dsh plugin scaffolds each Project Workspace and keeps its Project Brief

Every Project Workspace gets a **Project Scaffold** — a conventional research
directory layout — and a **Project Brief** (`PROJECT.md`), both delivered by a
second cordis plugin this package ships into its dsh harness child over the same
per-launch `--patch` mechanism as the command bridge (docs/adr/0011). The
scaffold is idempotent and create-only; the Brief is a companion document the
agent keeps current through two model-callable tools, and the record stays its
only authority.

- **Status**: accepted
- **Context**: a Project Workspace is created lazily and empty — `FsWorkspace`
  makes only the root on first touch and deliberately creates no subdirectories
  (`packages/workspace/src/fs-workspace.ts`), and `POST /api/projects` writes a
  record row, not a directory. A research project therefore starts as a blank
  folder, and nothing on disk tells either the Researcher or the Agent what shape
  the work should take. The record layer is authoritative for Project metadata
  (`id`, `name`, `createdAt`) but has no narrative surface, and `Study` / `Task` /
  `Artifact` are deferred with no producer or reader (docs/adr/0007), so a
  heavyweight record entity for "progress" / "milestones" would be premature.
  Meanwhile the dsh harness child already runs each Project's agent IN that
  Project's own directory (docs/adr/0008) and already accepts a launch-time
  cordis plugin (docs/adr/0011), which is the one place with both the cwd and the
  session lifecycle needed to lay down a layout and prompt its upkeep.
  *Considered and rejected*: scaffolding at Project creation, service-side. It
  would make the layout visible in the Files panel before the first turn, but it
  couples a filesystem convention to the record-creation path (which owns no
  files), and it is not a dsh plugin — the requested shape. The window it closes
  is small: a Project with no agent work has no transcript and nothing to brief.
- **Decisions**:
  - **A second launch artifact, not a second bridge.** `project-plugin.ts` is a
    dependency-free cordis plugin in this package's build output. The adapter
    writes a second one-entry profile patch (`--patch <file>`) inserting it by
    `file:` URL with the Project metadata as its config, and appends it to the
    launch patch list next to the command-bridge patch. Like the bridge it never
    writes to stdout and it fails SOFT — a missing config or a failed
    registration logs one stderr line and leaves the child running.
  - **It activates only for a real Project.** The plugin is a no-op unless its
    config carries Project metadata. The dsh example apps run a child whose cwd is
    an arbitrary `DSH_WORKSPACE`, and a `NullWorkspace` deployment has no agent
    view at all; neither should sprout a research layout.
  - **The scaffold is idempotent and create-only.** It lays down the directory set
    and `PROJECT.md` when missing and never overwrites, renames, or deletes
    anything: a re-run after a harness restart or in a second Session of the same
    Project is a no-op. The directory set is a default the config may override.
  - **`PROJECT.md` is a companion, the record is the authority.** The template
    renders the record-owned `id` / `name` / `createdAt`, which the adapter cannot
    see today, so `RuntimeInitOptions` gains an optional read-only
    `project: { id; name; createdAt }` bag that the service fills from
    `records.getProject`. The Brief is never read back as record truth.
  - **The Agent maintains the Brief through two tools, the plugin stamps time.**
    A `systemPrompt` section tells the agent to read the Brief at the start of
    work and update it at natural checkpoints; `project_update` replaces one named
    section and `project_log` appends one dated line to the progress log. The
    plugin — not the model — writes the date, and both tools reject a missing
    Brief rather than inventing one. The tool definitions are plain objects with
    JSON Schema parameters and an output `render`, so the plugin imports nothing
    from `@deepseek-ai/*` (the same dependency-free rule as the bridge).
  - **A `/project` command ensures and reports.** A no-arg command
    (`/project`) runs the idempotent scaffold and answers with what now exists,
    giving a Researcher an explicit way to (re)create or inspect the layout. It is
    registered in the harness registry like any other command and added to the
    cold fallback catalog so it is in the slash menu before the first turn.
- **Consequences**: the dsh menu, prompt, and tool list now carry one row each
  this package owns; a harness pin that moves `agent/session-start`, or the
  `commands` / `tools` / `systemPrompt` service names, degrades to a silently
  inert plugin (Cordis withholds a plugin whose injected services are absent;
  nothing throws). The scaffold is a convention, so an agent that renames or
  deletes a directory gets no correction — only a missing file is ever recreated.
  Milestones and progress live as prose in the Brief, not as record entities; if a
  real `Study` / `Task` producer arrives (docs/adr/0007) the Brief is where the
  reader will look first, and this decision should be revisited then. Windows
  inherits the launch patch unchanged; unlike the bridge it opens no socket, so it
  has no path-length foot-gun.
