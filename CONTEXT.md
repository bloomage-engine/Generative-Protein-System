# Science Studio

A research-agent platform for natural-science (life-science) R&D. It combines an
agent execution engine with a traceable research-record layer: agents act, and every
action lands as a reproducible, attributable scientific record.

## Language

**Science Studio**:
The product. A platform where researchers and managers run and observe agent-driven
R&D work, with full traceability.
_Avoid_: Scientist Studio, Lab Studio, Bio Studio

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
restart starts a fresh harness session; see docs/adr/0004). Distinct from Science Studio's
**Session** (a Study-scoped conversation) — one Science Studio Session maps to
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

## Research Work

**Project**:
The top-level container owned by a Researcher or team. A Project owns one Project
Workspace and any number of Sessions, and everything its Sessions produce is
shared at the Project level. Managers view Project-level aggregates. The
platform's coarsest unit of oversight.
_Avoid_: Space, Organization, Folder

**Project Workspace**:
The one filesystem workspace a Project owns, shared flatly by every Session under
it. "Independent" means independent of other Projects, not of the Sessions inside
one — those are meant to share.
_Avoid_: Workspace (unqualified — collides with the dsh runtime term), Sandbox,
Project dir

**Session**:
A conversation between a Researcher and an Agent under a Project. Rendered as an
assistant-ui thread. Each Researcher turn drives one Run.
_Avoid_: Thread, Chat, Conversation

**Run**:
The atomic unit of traceability. One Agent execution in a Session, carrying its
inputs, parameters, tool calls, outputs, duration, and cost. The Runs of a
Project's Sessions are its shared record of results.
_Avoid_: Execution, Step, Attempt

**Runtime Command** (also **Slash command**):
A runtime-level operation invoked by a standalone "/"-prefixed user message
(e.g. "/status", "/model"). Handled by the agent runtime's own command surface,
not by the Research turn machinery: a command is visible in the conversation
but is **not** recorded as a Run. Invoked either from the composer slash menu or
by typing it directly.
_Avoid_: Tool, Special message, System command

**Command Catalog**:
The set of Runtime Commands a runtime exposes, surfaced in the composer slash
menu. Each entry carries an id, description, and the exact invocation text to
send. The catalog is produced by the runtime adapter (for openclaw, from the
gateway's `commands.list`) and fetched over `GET /api/transport/commands`, so
the frontend never hardcodes a runtime's command set.
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
_Avoid_: Job, Chore, Assignment

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
  persisted by a Science Studio-owned record layer, rolled up at the Project level.
  Artifact capture and conclusion synthesis are deferred until their real producers
  exist. Workflow (DAG) orchestration is a later overlay.
- **Runtime**: the agent runtime is swappable. Science Studio owns the research record;
  runtimes are adapters behind a single transport seam.
