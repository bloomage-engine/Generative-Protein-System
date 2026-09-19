# A dsh plugin instructs the parent to report subagent results

A **fourth dependency-free dsh child plugin** (`subagent-plugin.ts`) tells the
MAIN agent to pick up each delegated subagent's result when it arrives and
report it to the user in plain terms — closing the "and now report it" step the
harness leaves model-driven. It rides the same per-launch `--patch` as the
command bridge, project and cron plugins (docs/adr/0011, 0012, 0017), mounted
unconditionally in `DshAdapter.init`. Two deterministic UI counterparts to the
same optimisation — a recent-window default on the Subagents list and a
Details + Result view on the drill-in child tab — mean a user is never blocked
on the parent complying.

- **Status**: accepted
- **Context**: a delegated subagent's result already reaches the parent agent —
  a foreground `subagent` / `subagent_fork` tool call returns the child's final
  answer as the tool result, and a background run (the `sdk`-profile default)
  surfaces it as a settlement notice. What the parent does with it is
  model-driven, and the harness only supplies the "use subagent in the
  background by default" guidance (docs/adr/0016) — in practice the parent
  frequently does not synthesise the result and say what it found, and a weak
  model may skip the instruction entirely. The user has no easy surface either:
  the default Subagents panel lists only the last day of runs (the rest behind a
  History toggle), and the drill-in child tab was a bare transcript with no
  headline. A hard-fix would need a `Run`/`Artifact` record entity to carry
  "parent reported this child's result", which v1's record vocabulary
  (Project/Session/Run, docs/adr/0007) deliberately omits — and even then a
  weak model would just not populate it.
- **Decisions**:
  - **A host-scope prompt section, best-effort, like its three siblings.**
    `packages/transport-dsh/src/subagent-plugin.ts` registers ONE host-scope
    `systemPrompt.section` (order 455, alongside 450 project / 460 cron) that
    tells the parent to read each delegated subagent's result (a tool result or
    a settlement notice) and summarise the key finding and conclusion in plain
    terms — and to name errors / a missing closing message plainly. It imports
    nothing from `@deepseek-ai/*`, never writes stdout, and fails soft like the
    bridge / project / cron plugins. It is a prompt steer, NOT an enforcement: a
    weak model may still skip it.
  - **Mounted unconditionally, so `project-default` gets it too.** The
    instruction is about the `subagent` tool, not a Project, so
    `DshAdapter.init` writes its launch patch (`writeSubagentPatch`) OUTSIDE the
    `if (opts.project)` gate the project and cron plugins sit in — a real Project
    AND `project-default` alike. It carries a `config: {}` node for harness-format
    parity with the other three.
  - **The two UI counterparts are deterministic (they do not depend on the
    model).** The Subagents panel default view becomes a RECENT WINDOW — default
    24 h, configurable 1–720 h — rather than only running rows, with `running`
    always visible. Each drill-in child tab gains a **Details** row (provider,
    model, started→ended, status, and `stopReason` when the transcript carries
    one) and a highlighted **Result** section carrying the child's final
    assistant message's text (or a "No closing message." fallback). The window
    setting lives in the service-owned settings file (docs/adr/0015) — a new
    `Subagents` tab next to Model / Plugins / Agent in the workbench dialog —
    and the panel resolves it via `useSubagentsWindow`; the drill-in reads
    verbatim from the existing `SubagentTranscript` (docs/adr/0016), whose
    `stopReason?` was added for this.
  - **The seam stays optional; dsh implements it.** `subagents?` /
    `subagentTranscript?` remain optional runtime seams (docs/adr/0016); this
    ADR adds no record field, no `Run` projection, and no openclaw surface.
- **Consequences**: parent-reporting is a best-effort prompt steer on dsh only
  — always on for dsh (real Projects and `project-default`), inert in a
  non-delegating session (the instruction is conditional on a result arriving),
  and a weak model may still skip it. The user is covered anyway by the
  recent-window list and the deterministic Details + Result drill-in. An
  out-of-range or non-integer `visibleWindowHours` is a `400` from the service
  (matching the 1–720 h bounds the UI enforces), and the UI falls back to the
  default when it cannot read one. Nothing enters the record vocabulary
  (Project/Session/Run, docs/adr/0007), and an openclaw analogue is a future
  optional `RuntimeAdapter` surface, not this change.
