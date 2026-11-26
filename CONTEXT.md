# Generative Protein System

A research-agent platform for natural-science (life-science) R&D. It combines an
agent execution engine with a traceable research-record layer: agents act, and every
action lands as a reproducible, attributable scientific record.

## Language

**Generative Protein System**:
The product. A platform where researchers and managers run and observe agent-driven
R&D work, with full traceability.
_Avoid_: Scientist Studio, Lab Studio, Bio Studio

**Desktop App**:
The self-contained single-user form of Generative Protein System: it runs on the Researcher's
own machine, with the agent runtime and the research record local to it. The same
product also runs as a hosted server for many users; "Desktop App" names the local
delivery form, not a different product.
_Avoid_: Client, GUI, Frontend

**Researcher**:
A domain expert who defines research objectives and reviews agent-produced results.
_Avoid_: User, Scientist, Lab worker

**Manager**:
A stakeholder who monitors research progress, resource usage, and outcomes across
projects without performing the work themselves.
_Avoid_: Admin, Adminstrator, Supervisor

**Agent**:
An abstract unit of work. May be powered by a large language model (LLM, autonomous,
multi-step, tool-calling) or be a deterministic script/pipeline. The platform treats
both uniformly.
_Avoid_: Bot, Assistant, Automation

## Agent Runtime (dsh)

Vocabulary contributed by the dsh (DeepSeek Harness) runtime adapter. Science
Studio terms above (Session, Run, …) are unchanged; these are runtime-domain
concepts the adapter maps to and from the record layer.

**Harness Session** (also **dsh Session**):
dsh's own unit of conversation: an append-only log of typed session events,
persisted under the dsh home and reusable by id within a running harness
process (the pinned SDK cannot resume an id a previous process persisted — a
restart starts a fresh harness session; see docs/adr/0004). Distinct from Generative Protein System's
**Session** (a Study-scoped conversation) — one Generative Protein System Session maps to
one Harness Session per harness-child generation. _Avoid_: Session (unqualified, collides with the product
term), Thread, Log

**Turn**:
dsh's unit of agent work: zero or more Steps, opened when input is claimed and
closed by `turn/end` with a reason (`completed`, `error`, `aborted`, …). One
Researcher turn (one Run-driving user message) maps to one Harness turn.
_Avoid_: Round, Cycle, Iteration

**Step**:
one model request plus the tools it calls, inside a Turn. Coarser than a
message; a single assistant reply can span multiple Steps as tools run.
_Avoid_: Call, Request, Segment

**Harness cwd** (dsh's own docs call it *Workspace*):
the filesystem directory a dsh agent operates in (executes tools against,
reads/writes files in). Supplied by the host at initialize time; under a Project
it is that Project's Project Workspace.
_Avoid_: Workspace (collides with Project Workspace), Sandbox, Home

## Skills (dsh)

Vocabulary for the dsh skills system as the workbench exposes it
(docs/adr/0020). A skill is a runtime-owned file or registration, never a record
entity.

**Skill**:
A dsh on-demand capability description: instructions the model loads into
context only when a task matches, rather than every session carrying the full
text. It is discovered from ranked filesystem roots, or registered at runtime by
a plugin; the model is told its name and description and loads the full content
through the `skill` tool. _Avoid_: Tool (skills are instructions, not callable
functions), Prompt, Template

**Global Skill** vs **Project Skill**:
A Global Skill lives in a user-level root and is shared across every Project; a
Project Skill lives in one Project's Project Workspace and is visible only to
that Project's agent. The workbench lists Global Skills read-only and installs /
removes Project Skills (docs/adr/0020). _Avoid_: User skill, System skill

**Project Skill Root**:
The Project Workspace directory `.dsh/skills/` — a Project Skill is the bundle
`.dsh/skills/<name>/SKILL.md`. (`.agents/skills/` is a cross-agent shared
convention the workbench only reads.) _Avoid_: Skill dir, Skills folder

**Skill Source** (rank):
Which root a Skill was discovered under, in dsh's priority order: `project-dsh`
(100), `project-agents` (200), then user-level `user-dsh` (400) and
`user-agents` (500). A nearer source's same-name Skill shadows the farther one.
_Avoid_: Layer, Priority, Origin

**Skill Invocation Policy** (also **Skill Invocation**):
The two independent booleans a Skill declares — `modelInvocable` (may the model
see it in its catalog and load it) and `userInvocable` (may a user trigger it
with a `/name` gesture). dsh reads them from the frontmatter
(`disable-model-invocation`, `user-invocable`); they are the only per-skill
switch, as the runtime has no enable/disable API. _Avoid_: Enabled, Visibility,
Permission

## Research Work

**Project**:
The top-level container owned by a Researcher or team. A Project owns one Project
Workspace and any number of Sessions, and everything its Sessions produce is
shared at the Project level. Managers view Project-level aggregates. The
platform's coarsest unit of oversight. The auto-ensured bootstrap Project cannot
be renamed, archived or deleted (docs/adr/0014).
_Avoid_: Space, Organization, Folder

**Worktree**:
A git worktree of a Project's repository: an isolated checkout on its own branch,
which groups the Sessions that run in it under one working directory and one
runtime (docs/adr/0025). A Project's root directory IS its reserved `main`
Worktree; linked Worktrees live under `.worktrees/<id>/`. `id` is unique within
the Project and immutable, `name` is the only mutable field, and the on-disk path
is derived from the id, never stored. A Session belongs to exactly one Worktree.
_Avoid_: Branch (a Worktree is a checkout, not just a ref), Clone, Project
Workspace

**Delete**:
The irreversible-from-the-UI removal of a Project or Session: the record rows go
(a Project cascades its Sessions and their Runs; a Session cascades its Runs) and
a Project's Project Workspace is moved to the Recycle Bin. The default Project
cannot be deleted (docs/adr/0014).
_Avoid_: Archive, Remove, Trash

**Archive**:
The reversible hiding of a Project or Session: the record keeps an `archivedAt`
timestamp, the row leaves the default listing, and clearing the timestamp brings
it back. Files are untouched.
_Avoid_: Delete, Remove, Trash

**Recycle Bin**:
Where a deleted Project's Project Workspace is physically moved (a sibling
`.recycle/` directory under `PROJECT_ROOT`) when the Project is deleted
(docs/adr/0014). A filesystem safety net for manual recovery, never a product
surface: the UI offers no restore for delete.
_Avoid_: Trash, Backup, Archive


**Project Workspace**:
The one filesystem workspace a Project owns, shared flatly by every Session under
it. "Independent" means independent of other Projects, not of the Sessions inside
one — those are meant to share.
_Avoid_: Workspace (unqualified — collides with the dsh runtime term), Sandbox,
Project dir

**Project Scaffold**:
The conventional directory layout a Project Workspace starts with — `docs/`,
`references/`, `data/{raw,interim,processed}`, `scripts/`, `notebooks/`,
`models/`, `reports/`, `logs/`, `config/` — laid down the first time an agent
works in the Project, so a research project has a predictable shape from its
first turn. The Project Brief's `工作区结构` section indexes each entry (and
`PROJECT.md` itself) with its purpose. A convention over the filesystem, not a
record entity: it is never enforced, and laying it down only ever ADDS what is
missing.
_Avoid_: Template, Skeleton, Folder structure

**Project Brief** (the `PROJECT.md` file):
A Markdown document at a Project Workspace's root that narrates the project —
background, objectives, methods, milestones, progress log, current status,
results, open questions — kept current by the Agent as the work proceeds. A
companion to the record, never its authority: the record owns Project metadata
(`id`, `name`, `createdAt`); the Brief is prose a human reads.
_Avoid_: Project doc, README, Log

**Session**:
A conversation between a Researcher and an Agent under a Project. Rendered as an
assistant-ui thread. Each Researcher turn drives one Run.
_Avoid_: Thread, Chat, Conversation

**Scope**:
The `(Project, Worktree, Session)` a request acts under: the claim a client
sends, and the one thing the service resolves it against (the query first, then
the body — docs/adr/0025). The workbench remembers the last Scope per browser and
resumes it on load, but only once the record confirms it (docs/adr/0009). An
address, not a container — the Project, Worktree and Session keep their own
meanings.
_Avoid_: Context, Filter, Selection

**Run**:
The atomic unit of traceability. One Agent execution in a Session, carrying its
inputs, parameters, tool calls, outputs, duration, and cost. The Runs of a
Project's Sessions are its shared record of results. It is the rollup — one `Run`
per turn; the Session's full conversation is its `Transcript` (docs/adr/0019).
_Avoid_: Execution, Step, Attempt

**Transcript**:
The durable, full canonical message view of one Session — every message with its
tool calls, reasoning, and multi-part text. Persisted by the Science
Studio-owned record and keyed by the Session's stable id (docs/adr/0019); the
restore path reads it back, so a settled conversation survives a service
restart. Richer than a `Run` (one turn); the `Run` is the rollup projection
derived from it.
_Avoid_: Mirror, History, Conversation log (a runtime's in-memory mirror is a
cache, not the source of truth)

**Subagent**:
An agent run delegated by a parent Session's agent — the "subagent" the Subagents
panel shows. In v1 it is a durable, stably-identified entity in the record
(docs/adr/0019): a stable id, a durable parent-session lineage, its run metadata,
and its own captured transcript, so it survives a service restart and its
transcript is replayable. A runtime exposes it live through the optional
`subagents?` surface (docs/adr/0016).
_Avoid_: Task (a deferred work item), Job, Harness child

**Runtime Command** (also **Slash command**):
A runtime-level operation invoked by a standalone "/"-prefixed user message
(e.g. "/status", "/model"). Handled inside the Runtime Adapter — by the runtime's
own command surface, or by the adapter itself when the runtime exposes none
(docs/adr/0010) — and never by the Research turn machinery: a command is visible
in the conversation but is **not** recorded as a Run. A runtime whose command
surface needs session state it does not have yet may have to CREATE it first
(dsh drives the line as the session's first prompt and its child's pre-step
interception runs the registry instead of the model, docs/adr/0011) — that is
still a command, not a turn. Invoked either from the composer slash menu or by
typing it directly.
_Avoid_: Tool, Special message, System command

**Command Catalog**:
The set of Runtime Commands a runtime exposes, surfaced in the composer slash
menu. Each entry carries an id, description, and the exact invocation text to
send. The catalog is produced by the runtime adapter and fetched over
`GET /api/transport/commands` (per Project, like every transport route), so the
frontend never hardcodes a runtime's command set: openclaw curates its gateway's
`commands.list`, while dsh merges the commands its adapter answers itself with
the harness's OWN registry, read from the harness child over the command bridge
(docs/adr/0010, docs/adr/0011) — and while that child is cold (the registry is
agent-scoped, so it cannot be enumerated before the first turn) with a curated
list of the pinned profile's own commands.
_Avoid_: Menu config, Slash list, Command registry

## Structure Viewing (MolQL)

Vocabulary for the molecular-structure preview and the agent's ability to drive
it. The viewer is a renderer over a Project Workspace file, not a record entity.

**Structure File**:
A molecular structure in a file the Project Workspace holds — PDB, mmCIF/BCIF,
MOL/MOL2, SDF, XYZ, GRO, … Detected by file name (their MIME types are not in the
workspace map); opened in the center pane's structure preview.
_Avoid_: Model file, Molecule, Protein file

**MolQL**:
The selection language the agent speaks to the structure viewer. It is Mol*'s
`mol-script` S-expression language, e.g. `(sel.atom.chains (= atom.chain A))`,
`(sel.atom.res (in-range atom.resno 10 20))`. The model translates natural
language into MolQL; the viewer compiles it with Mol*.
_Avoid_: MolScript query, Selection string, SQL

**Selection**:
The set of atoms a MolQL expression resolves to against the loaded structure,
plus how it is shown. `"select"` (default) is a persistent selection that stays
highlighted and visible in Mol*'s selection list; `"highlight"` is a transient
emphasis. Selecting also focuses the camera unless told otherwise.
_Avoid_: Highlight (when the persistent mode is meant), Mark, Pick

**`molql` Tool**:
The single agent tool that carries a MolQL expression to the viewer, registered
by both runtime plugins (`molql-tool-dsh`, `molql-tool-openclaw`). It returns the
JSON contract `{ type:"molql-selection", molql, description?, focus?, mode? }`;
the web app parses it and applies it. The tool does not validate against a
structure — only the browser can.
_Avoid_: Molstar tool, Structure tool, Viewer command

**`computeInteraction` Tool**:
The agent tool (both runtime plugins) that computes the non-covalent interactions
— hydrogen bonds, pi-stacking, cation-pi, halogen bonds, metal coordination,
molstar's defaults — involving a selection. It fetches the service's
`/api/workspace/interactions` (the service owns file access and runs molstar
headlessly), passing the `@<project>/<path>/<molql>` mention split into
`project`/`path`/`molql`, and returns a Markdown table.
_Avoid_: Interaction tool, Contact tool, Molstar interaction

**`measurements` Tool**:
The agent tool (both runtime plugins) that measures a structure and draws the
same measurement in the viewer. `kind` is `label`/`distance`/`angle`/`dihedral`/
`orientation`/`plane`; `selections` is the ordered list of MolQL expressions (or
`@<project>/<path>/<molql>` mentions, parsed deterministically) that defines
A/B/C/D. The service computes the value with the same molstar formulas the viewer
draws and returns it, so one result serves both the model and the 3D view.
_Avoid_: Measure tool, Geometry tool, Molstar measurement

**MCP Server**:
An external Model Context Protocol tool server the dsh agent can call. Its
deployment row lives in `settings.mcp.servers`; it is either **Global** (every
Project) or **Project-scoped** (only the Project named by `projectId`). It is
not a Project workspace file, because its credentials are write-only deployment
secrets.
_Avoid_: Tool server config, Integration, Connector

**MCP Tool**:
A tool discovered from an MCP Server and registered by the dsh bridge as
`mcp__<server id>__<tool>`. Calls and results travel as ordinary tool-call parts.
_Avoid_: Plugin, Skill, Native tool

**MCP Probe**:
The workbench's Test connection action: a one-shot `@modelcontextprotocol/sdk`
connection that lists a candidate server's tools and disconnects. It is not the
agent's live MCP connection.
_Avoid_: Health check, Ping

**Selection Mention**:
The composer text `@<project>/<workspace path>/<MolQL expression>` produced when
the user clicks a residue, an atom or a bond/dashed interaction in the structure
preview while Mol*'s selection mode is on. The viewer reports the target as domain
data: chain/resno/resname (a residue, or a single atom at Mol*'s "Atom/Coarse
Element" picking level), the two endpoint atoms of a bond, or the two
representative endpoint atoms of a non-covalent interaction — the last carrying a
` #<interaction type>` suffix (e.g. ` #Hydrogen Bond`), which the agent-side tools
strip. The app toggles the mention in the draft — a second click on the same
target removes it, matching Mol*'s `clickToggle` — so the next message names both
the file and the selection.
_Avoid_: Highlight text, Residue link, Click command

**Workflow** (also **DAG**):
A composition overlay that chains multiple steps so that one Run's output becomes
a downstream step's input. Optional in the first version; a later structured mode
over the Run-based record.
_Avoid_: Pipeline, Chain, Script

### Deferred vocabulary

Named and agreed, but not in v1: no record entity, no API, no rendering. Each
returns when its real producer or reader is designed (see docs/adr/0007).

**Study**:
A single scientific question or objective pursued under a Project; an optional
grouping of Sessions into an investigation line.
_Avoid_: Experiment, Case, Investigation

**Task**:
A concrete piece of work delegated to an Agent (e.g. "run differential expression
on this dataset").
_Avoid_: Job, Compute Job (that is remote scheduled work, not a Task), Chore,
Assignment

**Artifact**:
An output produced by a Run — a dataset, figure, report, code, or model.
Referenced by other Runs as input.
_Avoid_: Output, File, Result

**Evidence** (also **Provenance**):
The chain linking a Run to its inputs, intermediate steps, Artifacts, and
conclusions. What makes the platform's records auditable and reproducible.
_Avoid_: History, Log, Audit trail

**Conclusion** (also **Report**):
A synthesized finding presented to the Researcher, citing the Evidence and
Artifacts that support it.
_Avoid_: Summary, Output document, Answer

**AgentBlueprint**:
A reusable definition of an Agent — its instructions, tools, model, and
parameters.
_Avoid_: Agent config, Agent template, Skill

### Core decision

The platform records its work at the granularity of a **Run**: everything needed to
reproduce and attribute an action hangs off a single Run. Sessions aggregate Runs,
and a Project aggregates its Sessions — so a Project's shared record of results is
the Runs of all of them.
_Avoid_: Recording at the depth of Project, Session, or Artifact as the atomic unit.

### Scope decisions

- **Domain**: computational / in-silico work first (analysis, modeling, literature,
  hypothesis generation). Wet-lab and instrument integration is deferred. Managerial
  governance is a thin cross-cutting layer.
- **Interaction**: conversation-first. Every Researcher turn is captured as a Run and
  persisted by a Generative Protein System-owned record layer, rolled up at the Project level.
  Artifact capture and conclusion synthesis are deferred until their real producers
  exist. Workflow (DAG) orchestration is a later overlay.
- **Runtime**: the agent runtime is swappable. Generative Protein System owns the research record;
  runtimes are adapters behind a single transport seam.

## HPC Compute

Vocabulary for running Compute Jobs on external HPC systems over SSH
(docs/adr/0024). The connection is a deployment fact; its use is Project state.

**HPC Endpoint**:
A remote compute system Generative Protein System is configured to submit Compute Jobs to —
a Slurm cluster or a plain Linux machine. Its definition lives in deployment
settings; a Project binds to one to use it.
_Avoid_: Cluster, Server, Remote, Queue

**Compute Job**:
A unit of remote work submitted to an HPC Endpoint and tracked as a record
entity — a scheduler job where the Endpoint has one, a tracked background
process where it does not. It belongs to a Project; the Session that submitted
it is metadata.
_Avoid_: Job (unqualified), Batch job, Run (that is a Research turn), Task

**Scheduler Kind**:
Whether an Endpoint's jobs are governed by Slurm (`slurm`) or executed directly
on a plain machine (`linux`). The extension point for future schedulers.
_Avoid_: Backend, Queue type, Mode

**Project HPC Binding**:
A Project's choice of HPC Endpoint plus its Project-level defaults (Remote Work
Dir, default partition, default time), shared by every Session in the Project.
A Project with no Binding cannot run jobs.
_Avoid_: Endpoint config, Cluster settings

**Remote Work Dir**:
The directory on an HPC Endpoint owned by one Project, where its Compute Jobs
run and its Staged files live. A job never sees the Project Workspace directly.
_Avoid_: Scratch, Home, Staging area

**Staging**:
An explicit copy between the Project Workspace and a Project's Remote Work Dir.
Never automatic: large datasets are assumed to already live on the cluster.
_Avoid_: Sync, Mirror, Upload (as the domain term)

**Compute Job State**:
Where a Compute Job stands in its lifecycle: `submitted` → `pending` → `running`
are non-terminal; `completed` / `failed` / `cancelled` are terminal; `unknown`
means Generative Protein System could not confirm the remote truth and keeps the last known
state. The remote scheduler remains the authority; our state is a reconciliation.
_Avoid_: Status (the record's own term), Queue position
