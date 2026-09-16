# The dsh project plugin: scaffold and Project Brief

Every Science Studio **Project Workspace** gets a conventional research
directory layout and a `PROJECT.md` **Project Brief**, laid down and kept
current by a child-side dsh plugin. The plugin is a launch artifact: the adapter
mounts it into a Project's harness child with a per-launch `--patch`, next to the
command bridge (docs/adr/0011, docs/adr/0012).

- `packages/transport-dsh/src/project-scaffold.ts` — the pure layout + document
  contract (no cordis, no harness).
- `packages/transport-dsh/src/project-plugin.ts` — the child-side cordis plugin.
- `packages/transport-dsh/src/bridge.ts` — `writeProjectPatch`, the adapter-side
  launch patch.

## When it runs

The plugin activates **only for a real Project**: its launch config carries the
record's `id` / `name` / `createdAt`. A dsh example app (an arbitrary
`DSH_WORKSPACE`, no Project) is never given one, and a Project row the deployment
does not have simply has none. It fails soft — a missing config or a failed
registration logs one stderr line and leaves the child running.

It acts at three moments:

- **`agent/session-start`** — the first turn of any Session in the Project runs
  the scaffold.
- **`/project`** — an explicit command that ensures the layout and reports what
  now exists. It is in the slash menu from the first page load, cold or warm.
- **The Agent tools** — `project_update` and `project_log` keep the Brief current
  as work proceeds, guided by a system-prompt section that tells the Agent to
  read the Brief at the start of work and update it at natural checkpoints.

Scaffolding is **idempotent and create-only**: it adds what is missing and never
overwrites, renames, or deletes anything, so a re-run after a harness restart or
in a second Session of the same Project is a no-op.

## Research layout

| Directory | Purpose |
| --- | --- |
| `docs/` | working notes, methods, protocols |
| `references/` | literature, bibliographies, reading notes |
| `data/raw/` | immutable source data (never edited) |
| `data/interim/` | cleaned or partial intermediates |
| `data/processed/` | analysis-ready datasets |
| `scripts/` | analysis code and pipelines |
| `notebooks/` | interactive / exploratory analyses |
| `models/` | trained models and checkpoints |
| `reports/` | written reports, manuscripts, slides |
| `logs/` | run and tool logs |
| `config/` | environment and parameter manifests |

The layout is a convention over the filesystem, not a record entity: it is never
enforced, and an Agent that renames or removes a directory gets no correction.
The Brief's `工作区结构` section indexes every entry above (plus `PROJECT.md`
itself) with its purpose, generated from the same `SCAFFOLD_ENTRIES` list the
scaffold creates, so the documentation cannot drift from the layout.

## The Project Brief (`PROJECT.md`)

A Markdown document at the workspace root, in this section order:

`背景与动机` · `研究目标与科学问题` · `范围与非目标` · `方法与技术路线` ·
`关键节点` · `进度日志` · `当前状态与下一步` · `关键决策` · `数据与来源` ·
`结果与发现` · `未决问题与风险` · `工作区结构` · `参考资料`

The template renders the record-owned identity (`id`, `name`, `createdAt`) and a
bootstrap entry in the progress log. **The record is the authority**; the Brief
is prose a human reads and is never read back as record truth. Milestones and
progress live as prose here, not as record entities — `Study` / `Task` /
`Artifact` remain deferred (docs/adr/0007).

## Tools

The Agent maintains the Brief through two model-callable tools:

- `project_update({ section, content })` — replace one named section's body.
  `section` is one of the headings above; an unknown one is answered with the
  available list, not applied.
- `project_log({ entry })` — append one line to `进度日志`.

The **plugin stamps the date**, not the model. A missing `PROJECT.md` is reported
("run `/project` first"), never invented by a tool.

## Configuration

The launch config is written by the adapter and its only required field is
`project`. Optional:

- `root` — the workspace root; defaults to the child's cwd (the Project
  Workspace, docs/adr/0008).
- `directories` — override the layout above.

## Verification

`packages/transport-dsh/test/project-scaffold.test.ts`,
`project-plugin.test.ts` and `project-launch.test.ts` cover the pure contract,
the plugin against a scripted context, and the launch patch. The real child —
that the `--patch` loads the plugin and `agent/session-start` scaffolds — is
checked by `scripts/smoke-dsh-command-bridge.mjs` (needs a launchable dsh child;
no model route required for the `/project` cold-command check).
