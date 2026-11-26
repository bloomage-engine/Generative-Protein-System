# dsh skills configuration in the Settings dialog — design

## Problem

1. **The workbench cannot see dsh skills.** The harness discovers skills from
   ranked filesystem roots and lets the model load them on demand, but Science
   Studio has no view of that catalog and no way to add a skill to a Project
   short of editing the workspace by hand. The Skills tab is the missing editor.
2. **There is no skill surface on the wire.** The pinned SDK JSON-RPC exposes no
   skill discovery or load RPC, and `transport-dsh` never reads skills. Anything
   the workbench shows must be discovered by the adapter from the filesystem or
   from the harness itself.
3. **The two scopes have different natural powers.** Global skills live outside
   the Project Workspace (user-level roots) and should be observed only; project
   skills live inside the Project Workspace and are the ones a user wants to
   install/edit/remove.

## Decisions

### D1 — A Skills tab, dsh-only, with an asymmetric scope model

- **Placement.** A new **Skills** tab in `settings-dialog.tsx`, next to
  Model / Plugins / Agent / Subagents. Plugins and Agent stay reserved.
- **dsh-only, degrade cleanly.** The feature rides an optional `RuntimeAdapter`
  capability. A runtime without it (openclaw) reports unavailable and the tab
  shows a neutral message rather than a runtime-specific branch — the same shape
  the Subagents panel uses (`typeof adapter.subagents !== "function"`).
- **GLOBAL = read-only inventory; PROJECT = install / edit / remove.**
  Generative Protein System never writes outside the Project Workspace, so the global list
  (`<dshHome>/skills`, `<agentsHome>/skills`) is display-only. The project list
  (`.dsh/skills`, `.agents/skills`) adds install / remove, but only
  `.dsh/skills` is written: `.agents/skills` is a cross-agent shared convention
  and stays read-only to avoid contending for other agents' files.
- **Scope binding.** The project scope is the **active Project** from
  `studio-store` (same source the file tree uses). Switching Project refetches;
  there is no second Project picker in the dialog.
- **Restart semantics are per item, and stated.** The global list is read-only,
  so nothing to apply. A project install/remove is a workspace file the harness's
  filesystem provider watches, so it reaches a warm session without a service
  restart — the tab says "applies to the active session", unlike the Model tab's
  "restart the service to apply".

### D2 — The adapter owns the skill format, exposed as an optional surface

- **A new pure module** `packages/transport-dsh/src/skills.ts` owns:
  - **Discovery** — for each root, exactly one level deep (matching the harness):
    a directory bundle `<root>/<name>/SKILL.md`, or a flat `<root>/<name>.md`.
    Roots and ranks (rank = priority; a nearer root's same-name skill wins):

    | rank | source | root |
    | --- | --- | --- |
    | 100 | `project-dsh` | `<cwd>/.dsh/skills` |
    | 200 | `project-agents` | `<cwd>/.agents/skills` |
    | 400 | `user-dsh` | `<dshHome>/skills` |
    | 500 | `user-agents` | `<agentsHome>/skills` |

    `cwd` is the adapter's resolved agent cwd (the Project Workspace),
    `dshHome` the adapter's resolved home, `agentsHome` = `$DSH_AGENTS_HOME ??
    ~/.agents` (read here for the first time; the harness child does the same).
  - **Frontmatter parse** — `name` and `description` required; kebab-case name
    `^[a-z0-9]+(?:-[a-z0-9]+)*$`; optional `disable-model-invocation` /
    `user-invocable` (defaults: model yes, user yes). A malformed entry is
    dropped, never fatal — fail-soft, exactly as the harness treats it.
  - **Frontmatter serialize** — the inverse, for `installSkill`.
  - **Merge / shadow** — group by name, lowest rank wins, losing entries are
    returned with `shadowed: true` so the UI can show an override.
- **Surface on `RuntimeAdapter`** (all optional; presence is the capability
  check, mirroring `subagents?`):

  ```ts
  skills?(): Promise<SkillInfo[]>;
  installSkill?(input: SkillInstallInput): Promise<SkillInfo>;
  removeSkill?(name: string): Promise<void>;
  ```

- **No child launch.** Discovery and frontmatter parsing are pure filesystem
  work; a catalog read never boots the harness child.
- **Writes use the adapter's held workspace.** `installSkill` composes the
  bundle and calls `opts.workspace.write(".dsh/skills/<name>/SKILL.md", bytes,
  { createParents: true, overwrite })`; `removeSkill` calls
  `opts.workspace.delete?.(".dsh/skills/<name>")`. This inherits `FsWorkspace`'s
  containment/symlink/size invariants instead of a second write path. A
  `NullWorkspace` fails with the existing `WorkspaceUnavailableError` → 503.
- **Copy-from-global** is a thin second install path: `SkillInstallInput` gains
  an optional `copyFrom?: { name: string }`; the adapter reads the source bundle
  from the global roots (flat file or bundle with `references/**`) and writes it
  verbatim under the project root, returning the new `SkillInfo`. The form path
  and the copy path share the same write + overwrite/validation rules.

**Contract types** (`packages/transport/src/skills.ts`, new; re-exported from the
package root):

```ts
export type SkillScope = "global" | "project";

export interface SkillInvocationPolicy {
  modelInvocable: boolean;
  userInvocable: boolean;
}

export interface SkillInfo {
  name: string;              // kebab-case
  description: string;
  scope: SkillScope;
  source: string;            // "project-dsh" | "project-agents" | "user-dsh" | "user-agents"
  /** Host path (global) or workspace-relative path (project), for display. */
  path: string;
  invocation: SkillInvocationPolicy;
  /** A nearer-scope same-name skill overrides this entry. */
  shadowed?: boolean;
}

export interface SkillInstallInput {
  name: string;
  description: string;
  /** Markdown instructions body. */
  body: string;
  invocation?: { modelInvocable?: boolean; userInvocable?: boolean };
  /** Copy an existing global skill's bundle instead of the form fields. */
  copyFrom?: { name: string };
  /** Replace an existing project skill of the same name. */
  overwrite?: boolean;
}
```

- **Error classes** join the seam error set: `SkillInvalidError` (a general 400
  — bad name or empty description; `SkillNameInvalidError` is its name-specific
  subclass), `SkillExistsError`, `SkillNotFoundError` (the route maps them to
  HTTP).

### D3 — Routes and the web proxy

- **Service** (`services/transport-service/src/server.ts`, next to the subagent
  routes; validation helpers in a small `src/skills.ts`):
  - `GET /api/skills?projectId=` → `{ available: boolean, runtime: string,
    skills: SkillInfo[] }`. Resolves the Project's adapter via
    `scope.acquire(request)`; absent capability → `available: false`, empty list.
  - `POST /api/skills/install` → body `SkillInstallInput`; the existing manager
    gate (local/manager principal, 403 otherwise, like `PUT /api/settings`);
    `SkillNameInvalidError` → 400, `SkillExistsError` → 409,
    `WorkspaceUnavailableError` → 503, no capability → 501.
  - `POST /api/skills/remove` → body `{ name, confirm: true }`; same gate;
    400 invalid name / missing confirm, `SkillNotFoundError` → 404.
  - Both writes are POST so the web proxy keeps its GET/POST shape
    (docs/adr/0014's lifecycle routes take the same route).
- **Web proxy** `apps/web/app/api/skills/[[...path]]/route.ts` — one catch-all
  relaying GET/POST through `proxyToService` (auth forwarded, status/body
  verbatim), the shape `projects`/`cron` already use. No per-path logic.
- **Client** (`packages/transport-client/src/skills.ts`, new; re-exported):
  `fetchSkills(api, projectId)`, `installSkill(api, projectId, input)`,
  `removeSkill(api, projectId, name)`, plus the contract types. A failed list
  degrades to `{ available: false, skills: [] }` so the tab shows a neutral
  state instead of an error (the Subagents proxy's failure policy).

### D4 — The dialog

- **The tab is self-contained.** All state (list, loading, install form, error)
  lives inside `SettingsDialog`; it never moves into the runtime owner, so the
  transcript-destroying re-render guard is preserved
  (`settings-dialog.test.mjs`).
- **Layout.** Two sections — *Project* (install button; each row has Remove and
  an "overwritten"? marker) and *Global* (read-only; each row offers "Copy to
  project" when a project skill is allowed). An unavailable state names the
  reason ("Skills are available on the dsh runtime").
- **Install form** (a small dialog/popover inside the tab): name, description,
  body (a `Textarea` — added from the shadcn registry if absent),
  `modelInvocable` / `userInvocable` checkboxes, and an overwrite toggle. Client
  validation mirrors the service (kebab-case, non-empty description) but the
  service is the authority.
- **No edits to `settings.json`.** D1's deferral of `customSkillDirs` means this
  pass adds no `RuntimeSettings` field and no settings migration. The tab talks
  only to `/api/skills*`.

### D5 — Deferred

- **Global `customSkillDirs`** — a `skill-filesystem` config injected through a
  `- id: skill-filesystem` launch patch. A patch replaces the row's whole
  `config`, coupling Generative Protein System to the harness profile's current shape; not
  worth it until a concrete need exists.
- Editing the global roots, writing `.agents/skills`, uploading a packed bundle,
  and any skill registry/marketplace.

## Components

| Area | Change |
| --- | --- |
| contract | `packages/transport/src/skills.ts` (new) — `SkillScope` / `SkillInvocationPolicy` / `SkillInfo` / `SkillInstallInput`; re-export from `packages/transport/src/index.ts`; error classes in the seam error module; `RuntimeAdapter` gains `skills?` / `installSkill?` / `removeSkill?` in `types.ts` |
| dsh adapter | `packages/transport-dsh/src/skills.ts` (new) — discovery roots, frontmatter parse/serialize, rank merge/shadow, `installSkill`/`removeSkill` over `opts.workspace`; `packages/transport-dsh/src/adapter.ts` — implement the three methods (using the resolved `dshHome`, `agentsHome`, and agent cwd) |
| service | `services/transport-service/src/server.ts` — `GET /api/skills`, `POST /api/skills/{install,remove}` beside the subagent routes; `services/transport-service/src/skills.ts` (new) — request validation + error→HTTP mapping |
| client | `packages/transport-client/src/skills.ts` (new) — `fetchSkills` / `installSkill` / `removeSkill` + types; re-export from `packages/transport-client/src/index.ts` |
| web proxy | `apps/web/app/api/skills/[[...path]]/route.ts` (new) — catch-all `proxyToService` relay |
| web UI | `apps/web/components/studio/settings-dialog.tsx` — the Skills tab (list, install form, remove, copy-to-project, unavailable state); `apps/web/components/ui/textarea.tsx` if not present |
| docs | `docs/adr/0020-...md` (written); `CONTEXT.md` terms (written); `AGENTS.md` (the dialogs/tabs line + a skills sentence) |

## Error handling

- **No capability** → `GET` returns `{ available: false }`; writes return 501.
  The tab shows the unavailable state and no install affordance.
- **No Project Workspace** (`NullWorkspace`) → writes 503 via the existing
  `WorkspaceUnavailableError`; the tab shows the workspace-unavailable copy.
- **Invalid input** → 400 with the service's message; the form shows it and
  keeps the typed values.
- **Name collision** → 409 unless `overwrite`; the form offers to overwrite.
- **`remove` of an unknown skill** → 404.
- **A malformed skill file on disk** is dropped from the list (fail-soft), never
  an error state — the harness itself would drop it.

## Tests

- **adapter** (`transport-dsh/test/skills.test.ts`): discovery finds
  `<root>/<name>/SKILL.md` and `<root>/<name>.md`; nested files are NOT skills; a
  malformed frontmatter entry is dropped; a project-dsh name shadows a
  user-dsh one and the loser is marked `shadowed`; `installSkill` rejects a
  non-kebab name and an empty description, writes the expected SKILL.md text
  (frontmatter + trimmed body, invocation flags omitted at their defaults),
  and refuses an existing skill without `overwrite`; `removeSkill` deletes the
  bundle and 404s on an unknown name; `copyFrom` copies a global bundle's
  `SKILL.md` + `references/**`.
- **service** (`transport-service/test/skills-routes.test.ts`): `GET` with a
  capable fake adapter returns the list, and with an incapable one
  `available: false`; install → 400 / 409 / 200 and remove → 400 / 404 / 200;
  both writes 403 for a non-manager principal; no capability → 501.
- **client** (`transport-client/test/skills.test.ts`): `fetchSkills` degrades to
  `{ available: false, skills: [] }` on a failed hop and surfaces a non-2xx on
  writes.
- **web** (`apps/web/test/skills-tab.test.mjs`): opening Settings → Skills lists
  the mocked skills; install POSTs the form body and refetches; Remove POSTs the
  name + confirm; an unavailable response shows the neutral copy; the transcript
  still survives the interaction (the existing `settings-dialog.test.mjs`
  invariant).

## Docs

- **ADR 0020** (written): skills are configured through the workbench, backed by
  an optional adapter surface; the format authority and the write path; the
  scope asymmetry; the deferrals.
- **CONTEXT.md** (written): Skill, Global/Project Skill, Project Skill Root,
  Skill Source, Skill Invocation Policy.
- **AGENTS.md**: the workbench-shell line gains the Skills tab; the
  `transport-dsh` line gains the optional skills surface (filesystem discovery,
  project install via the Workspace seam, no child launch).

## Out of scope

- No record entity and no `settings.json` field.
- No `customSkillDirs`, no global-root editing, no `.agents/skills` writes, no
  bundle upload, no marketplace.
- No child launch for a catalog read, and no change to the SDK wire.
- No openclaw surface — the optional methods simply stay undefined there.
