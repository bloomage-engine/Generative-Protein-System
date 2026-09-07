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

## Research Work

**Project**:
The top-level container owned by a Researcher or team. Managers view Project-level
aggregates. The platform's coarsest unit of oversight.
_Avoid_: Workspace, Space, Organization

**Study**:
A single scientific question or objective pursued under a Project. A collection of
Runs forming an investigation line.
_Avoid_: Experiment, Case, Investigation

**Task**:
A concrete piece of work delegated to an Agent (e.g. "run differential expression on
this dataset").
_Avoid_: Job, Chore, Assignment

**Run**:
The atomic unit of traceability. One Agent execution against a Task, carrying its
inputs, parameters, tool calls, outputs, duration, and cost.
_Avoid_: Execution, Step, Attempt

**Artifact**:
An output produced by a Run — a dataset, figure, report, code, or model. Referenced
by other Runs as input.
_Avoid_: Output, File, Result

**Evidence** (also **Provenance**):
The chain linking a Run to its inputs, intermediate steps, Artifacts, and conclusions.
What makes the platform's records auditable and reproducible.
_Avoid_: History, Log, Audit trail

**Conclusion** (also **Report**):
A synthesized finding presented to the Researcher, citing the Evidence and Artifacts
that support it.
_Avoid_: Summary, Output document, Answer

**AgentBlueprint**:
A reusable definition of an Agent — its instructions, tools, model, and parameters.
Can be composed and referenced by Tasks.
_Avoid_: Agent config, Agent template, Skill

**Session**:
A conversation between a Researcher and an Agent under a Study. Rendered as an
assistant-ui thread. Each Researcher turn drives one Run.
_Avoid_: Thread, Chat, Conversation

**Workflow** (also **DAG**):
A composition overlay that chains multiple Tasks so that one Run's output becomes
a downstream Task's input. Optional in the first version; a later structured mode
over the Run-based record.
_Avoid_: Pipeline, Chain, Script

### Core decision

The platform records its work at the granularity of a **Run**: everything needed to
reproduce and attribute an action hangs off a single Run. Studies aggregate Runs;
Artifacts are produced by Runs; Conclusions cite Runs.
_Avoid_: Recording at the depth of Project, Study, or Artifact as the atomic unit.

### Scope decisions

- **Domain**: computational / in-silico work first (analysis, modeling, literature,
  hypothesis generation). Wet-lab and instrument integration is deferred. Managerial
  governance is a thin cross-cutting layer.
- **Interaction**: conversation-first. Every Researcher turn is captured as a Run and
  persisted by a Science Studio-owned record layer. The Artifact capture interface is
  reserved now and wired up later. Workflow (DAG) orchestration is a later overlay.
- **Runtime**: the agent runtime is swappable. Science Studio owns the research record;
  runtimes are adapters behind a single transport seam.
