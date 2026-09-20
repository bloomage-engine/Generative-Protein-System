# dsh skills are configured through the workbench, backed by an optional adapter surface

The workbench Settings dialog gains a **Skills** tab: a read-only inventory of
the skills the dsh harness discovers globally, plus install / edit / remove for a
Project's own skills. The skill FORMAT (frontmatter parse + serialize, the
discovery roots, the rank merge) lives in `transport-dsh` and is exposed as an
optional `RuntimeAdapter` surface — the service stays runtime-agnostic and only
routes. Project skills are ordinary Project Workspace files under
`.dsh/skills/<name>/SKILL.md`; the tab writes them through the adapter's held
`Workspace` seam so the containment/symlink/size invariants still apply.

- **Status**: accepted
- **Context**: the dsh harness ships a skills system (`ctx.skills` +
  `@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill`), on in the
  `sdk` profile Science Studio launches. Skills are discovered from fixed
  filesystem roots ranked project-first (`<projectRoot>/.dsh/skills` 100,
  `<projectRoot>/.agents/skills` 200) then user-level (`<dshHome>/skills` 400,
  `<agentsHome>/skills` 500), with a nearer layer's same-name skill winning.
  There is **no skill surface on the SDK JSON-RPC wire** and the adapter never
  reads skills today: to a running Science Studio the catalog is invisible, and
  there is no way to add a skill to a Project short of editing the workspace by
  hand. The harness itself has no runtime enable/disable API — a skill's
  invocation policy is its frontmatter. The service's deployment settings
  (docs/adr/0015) are global and restart-to-apply, but the harness child's cwd is
  the Project Workspace, so project skills are per-Project while user skills are
  global.
- **Decisions**:
  - **Format authority lives in `transport-dsh`, surfaced as an optional
    `RuntimeAdapter` capability.** Discovery + frontmatter parse/serialize is a
    pure module in the adapter package (`packages/transport-dsh/src/skills.ts`),
    reachable as `skills?()` / `installSkill?()` / `removeSkill?()` — the same
    optional-surface pattern as `subagents?` / `subagentTranscript?`
    (docs/adr/0016). It scans the filesystem WITHOUT launching the child, so a
    catalog read never boots the harness. The service route only calls the
    Project's own adapter (one per Project, docs/adr/0008) and must not
    statically import a runtime package; a runtime without the surface answers
    "unavailable" so the tab degrades instead of requiring a runtime branch.
  - **Two scopes, deliberately different powers.** GLOBAL skills (the user
    roots) are a READ-ONLY inventory — Science Studio does not write outside the
    Project Workspace. PROJECT skills (the project roots) are installable /
    removable: `installSkill` composes a bundle from structured input
    (kebab-case `name`, `description`, Markdown body, optional `modelInvocable` /
    `userInvocable`) and writes `.dsh/skills/<name>/SKILL.md`; `removeSkill`
    deletes that bundle. Only `.dsh/skills` is written; `.agents/skills` is a
    cross-agent shared convention and is shown read-only to avoid fighting other
    agents over the same files.
  - **Writes go through the Workspace seam, not a new store.** The adapter
    already holds the Project's `Workspace` (`RuntimeInitOptions.workspace`), so
    `installSkill` uses `workspace.write(relPath, bytes, { createParents, overwrite })`
    and `removeSkill` uses `workspace.delete?()` — the same primitive `CronStore`
    uses. The containment/symlink/size invariants are inherited, and a
    `NullWorkspace` (no `PROJECT_ROOT`) answers unavailable rather than writing
    to an implicit path.
  - **Not a record entity and not a settings field.** Skills enter neither the
    record vocabulary (Project/Session/Run, docs/adr/0007) nor `settings.json`
    (docs/adr/0015): they are runtime-owned files, and the harness's filesystem
    provider watches its roots, so a project install/remove is visible to a warm
    session without a service restart. The dialog says so per item (project
    changes "apply to the active session"; the global list is read-only).
  - **Writes are gated and validated.** `POST /api/skills/{install,remove}`
    carries the existing manager gate (a `local` or `manager` principal, as
    `PUT /api/settings` does); the adapter rejects a non-kebab-case name or an
    empty description and refuses to overwrite an existing skill unless
    `overwrite` is set. Deleting requires an explicit confirmation flag. Reads
    are open to any authenticated principal.
  - **Deferred, on purpose.** Global `customSkillDirs` (a `skill-filesystem`
    config injected via a `- id: skill-filesystem` launch patch) is NOT in this
    pass: a patch replaces the row's whole `config`, so it would couple Science
    Studio to the harness profile's present shape. Also deferred: editing the
    global roots, writing `.agents/skills`, uploading a packed bundle, and any
    skill registry/marketplace.
- **Consequences**: the Skills tab works only on dsh and only when a Project
  Workspace is configured; otherwise it shows an unavailable state. A skill
  added to a Project is immediately the highest-priority same-name skill for that
  Project's agent (rank 100), and the list marks a shadowed user-level entry.
  Runtime-registered skills that are not files (e.g. the molql plugin's embedded
  skill) do not appear — the inventory is file skills only, which is exactly the
  configurable set. No record field, no `Run` projection, no settings migration,
  and no openclaw surface; an openclaw analogue remains a future optional
  `RuntimeAdapter` surface.
