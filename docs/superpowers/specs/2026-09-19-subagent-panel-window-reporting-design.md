# Subagent list window, parent reporting, and drill-in result — design

## Problem

1. **The list is "running-only by default."** A run that finished an hour ago is
   already hidden behind the History toggle, even though the user is still
   working around it. There is no notion of "recent enough to keep showing."
2. **The parent doesn't report the child's result.** When a delegated subagent
   finishes, the main agent does not reliably pick up the child's result and
   summarize it to the user. The dsh harness already delivers the result to the
   parent (a foreground `subagent` tool-call returns the child's final answer as
   the tool result; a background run — the `sdk` default — surfaces it as a
   settlement notice), but nothing instructs the parent to synthesize and report
   it, so the outcome lives only in the panel.
3. **Drill-in is thin.** Double-clicking a subagent opens the child transcript
   with a small metadata header. There is no explicit "result" (the child's final
   answer) and no stop reason — the two things the user actually wants ("what
   did it conclude? why did it stop?") are not surfaced.

## Decisions

### D1 — The default view is "recent" (a configurable window); history is the archive

- **Predicate.** A run is in the DEFAULT (non-history) view if it is still
  `running` (any age) **OR** its most recent activity (`max(startedAt,
  finishedAt when present)`) falls within the window. The History toggle continues
  to show ALL runs (the archive) — unchanged. The predicate is pure and unit-testable:
  `isRecent(run, windowMs, now) = run.status === "running" || (lastActivity(run) >= now - windowMs)`.
- **The window** is a setting, in hours, **default 24**, range `1–720`
  (1 h – 30 d). Absent / invalid / a settings fetch failure → the client and panel
  both fall back to **24** (the feature never blocks on the hop).
- **Settings home.** A new first-class `subagents` section on the shared settings
  contract (alongside `model` / `plugins` / `agent`) — deliberately NOT the reserved
  opaque `agent` key. It is a distinct, type-safe surface with a named "Subagents"
  dialog tab, so it does not bleed into `model` semantics or abuse an opaque bag.
- **Service** (`services/transport-service/src/settings.ts`): `emptySettings()`
  gains `subagents: {}`; `mergeSettings` stores or clears `visibleWindowHours`;
  `viewOf` reports the **effective** number (default 24 when unset) so every
  consumer reads a plain number; `parseSettingsPatch` validates an integer
  `1 <= n <= 720` (a number), with `null` or `""` clearing it back to the default.
- **Client.** A `useSubagentsWindow(api?)` hook next to the existing settings
  helpers in `@science-studio/transport-client` — fetches `/api/settings` once,
  memoized per `api`, and returns the hours number (default 24, degrading to 24
  on failure or absence).
- **Panel.** A small PURE, testable helper module
  (`apps/web/components/studio/subagents-window.ts`, the same shape as
  `file-utils.ts`) exports the predicate `isRecent(run, windowMs, now)`;
  `SubagentsView` reads the window (via `useSubagentsWindow`), computes
  `windowMs`, and filters `visible` with it. The empty-state copy names the window
  ("No subagents in the last 24h"). Ordering stays as the ledger already yields
  (newest first).
- **Fail-soft**: an unavailable settings hop leaves the panel at the 24h default;
  this feature can never wedge the list because its only external dependency is
  a same-origin `GET /api/settings` that the dialog already exercises.

### D2 — A parent-reporting instruction rides a fourth dsh child plugin

- **The section.** A small, dependency-free cordis plugin (the exact pattern of
  `project-plugin.ts` / `cron-plugin.ts`: `name`, `inject = ["systemPrompt"]`,
  `apply(ctx) { ctx.systemPrompt?.section(...) }`, wrapped in
  `ctx.effect(...)` for teardown) that registers ONE host-scope
  `systemPrompt.section` — name `science-studio-subagent-reporting`, order distinct
  from the sibling sections (e.g. 455, chosen not to collide) — with text to the
  effect of: *"After a delegated subagent (`subagent` / `subagent_fork`)
  completes and its result arrives (a tool-result, or a settlement notice),
  summarize its key finding and report it to the user in plain terms. Do not
  silently drop a subagent's result."*
- **Why a plugin.** The section is **host-scoped** — these plugins ship as
  per-launch `--patch` patches, and a host-scope section is included in the
  **main agent's** prompt assembly (the same lever the harness uses for its own
  "use subagent in the background" guidance). That is exactly the gap: the
  result already reaches the parent; this only closes the "and now report it"
  step.
- **Honest scope.** This is a **prompt steer, best-effort**. A weak model may
  still skip it — which is precisely why D1 and D3 keep the result visible in the
  UI regardless. It is **always-on** (no toggle is requested this pass); the
  instruction is conditional ("after a delegated subagent completes…") so it is
  inert in sessions that never delegate. It is not a guarantee of parent behavior.
- **Mount.** Added unconditionally in `DshAdapter.initialize()` — a new
  `writeSubagentPatch({ dir, pluginPath })` (name only, empty config) is pushed
  onto `patches` alongside the bridge patch, gated on nothing (the bridge patch is
  the template). A `subagentPluginPath` default is `./subagent-plugin.js`. This
  makes the instruction reach both real-Project sessions AND `project-default`.

### D3 — The drill-in surfaces a Details block and a Result section

- The `subagent:<childId>` tab's renderer keeps the transcript as-is and adds two
  sections above it:
  - **Details** — status, provider, model (agent routing), started → finished, and
    **stopReason**.
  - **Result** — the child's final assistant message (the last `role: assistant`
    row in the transcript's `messages`, its text parts joined), i.e. the same text
    the parent is expected to report. A friendly "no closing message" state when the
    child produced none (a child that errored before any turn, or a still-running
    one read mid-flight).
- **`stopReason` gap.** `SubagentRun` already carries `stopReason`;
  `SubagentTranscript` does not. Add `stopReason?: string` to `SubagentTranscript`
  (shared type), populated by the dsh reader from `subagent.finished` / the child
  log's final `turn/end`, passed through the service, and exposed by the client
  hook. Absent when the log has no stop reason (fail-soft, not an error).

## Components

| Area | Change |
| --- | --- |
| #1 window | `packages/transport/src/settings.ts` — new `SubagentSettings` / `SubagentSettingsPatch` types; add to `RuntimeSettings`; `RuntimeSettingsView.subagents`; `RuntimeSettingsPatch.subagents?` |
| #1 service | `services/transport-service/src/settings.ts` — `emptySettings` / `mergeSettings` / `viewOf` / `parseSettingsPatch` for `subagents.visibleWindowHours` |
| #1 client | `packages/transport-client/src/settings.ts` — `useSubagentsWindow(api?)` hook (fetches `/api/settings` once; returns hours, default 24) + `subagentWindowFromView` pure helper (both exported from `packages/transport-client/src/index.ts`) |
| #1 web | `apps/web/components/studio/subagents-window.ts` (new, pure `isRecent` predicate — mirrors `file-utils.ts`); `apps/web/components/studio/{settings-dialog,subagents-view}.tsx` — a "Subagents" tab with the window input, and the panel's `visible` filter uses `isRecent` |
| #2 plugin | `packages/transport-dsh/src/subagent-plugin.ts` (new) — `name`, `inject = ["systemPrompt"]`, `apply` registers the reporting `section` (pattern of `project-plugin.ts` / `cron-plugin.ts`) |
| #2 adapter | `packages/transport-dsh/src/bridge.ts` — `writeSubagentPatch` (patch document, `file:` URL + empty config); `packages/transport-dsh/src/adapter.ts` — `subagentPluginPath` default + unconditional `patches.push(await writeSubagentPatch(...))` in `initialize()` |
| #3 type | `packages/transport/src/types.ts` — `SubagentTranscript.stopReason?` |
| #3 dsh | `packages/transport-dsh/src/{child-transcript,subagents}.ts` — surface `stopReason` on the read |
| #3 service | `services/transport-service/src/server.ts` — the transcript route already returns the adapter's read; nothing else changes once the type carries it |
| #3 web | `apps/web/components/studio/renderers/SubagentRenderer.tsx` — `TranscriptBody` gains a Details block and a highlighted Result section above the message list |

## Error handling

- **#1 settings fetch failure** → the client hook returns the 24h default
  (memoized, no retry storm); the panel degrades gracefully to the default and
  the rest of the workbench is unaffected (the settings hop is already an
  established path used by the dialog).
- **#1 invalid window value on save** → the service answers 400 with a message
  ("`subagents.visibleWindowHours` must be an integer 1–720"); the dialog shows it;
  the existing view/panel is untouched.
- **#2 plugin** → the section registration is wrapped in the plugin's disposal
  mechanism (the `ctx.effect(...)` + try/catch pattern the existing plugins use); a
  host without a `systemPrompt` surface simply registers nothing and the plugin is
  inert. No throw into the run stream, no bridge/socket side-effect.
- **#3 absence** → `stopReason` is `undefined` when the log has no stop reason;
  the Details block omits it. `result` is absent when the child produced no
  assistant message; the Result section shows the friendly empty state instead of
  an error. The transcript read itself already fails soft (torn tail / unknown
  format → `null` → the "record unavailable" state).

## Tests

- **#1 service** (`transport-service/test/settings.test.ts` or a
  subagents-adjacent file): `subagents.visibleWindowHours` round-trips — a number
  is stored, `null`/`""` clears it, the view reports the effective number (24 by
  default), and an out-of-range / non-integer value is a 400 with the expected
  message.
- **#1 client** (`transport-client/test/subagents.test.ts`): `useSubagentsWindow`
  resolves to 24 on a failed or absent `subagents` fetch and to the stored value
  otherwise.
- **#1 pure predicate** (`apps/web/test/subagents-window.test.mjs`, importing the
  pure `subagents-window.ts` helper the way `file-kinds.test.mjs` imports
  `file-utils.ts`): a still-running row is always recent; a row finished `2h` ago
  is recent within a 24h window; one finished `3d` ago is not; a row `running`
  for `10d` is still recent (the running branch wins the time check); a boundary
  row exactly at `windowMs` is included.
- **#2 plugin** (`transport-dsh/test/subagent-plugin.test.ts`): the plugin
  registers a section whose `name` and `text` contain the expected reporting
  instruction; a host without a `systemPrompt` surface registers nothing and does
  not throw; the disposal callback (when provided by `ctx.effect`) is invoked.
- **#2 adapter** (`transport-dsh/test/adapter.test.ts`): after `initialize()`, the
  launch config's `patches` list includes the subagent patch file, alongside the
  bridge patch — i.e. the instruction is unconditionally mounted.
- **#3** (`transport-dsh/test/adapter.test.ts` +
  `transport-service/test/subagents.test.ts` + the web drill-in test): a dsh child
  log whose final turn ends with a specific stop reason surfaces that `stopReason`
  on a `subagentTranscript` read; the service route passes it through (the read
  shape already flows — assert the new field); and the web drill-in renders the
  (mocked) `result` text alongside the Details block including the
  `stopReason`.

## Docs

- A short ADR following the 0011 / 0012 / 0017 plugin-record pattern for the
  **fourth dsh child plugin** (the parent-reporting instruction). The existing
  ADRs for the bridge / project / cron plugins are the template.
- `AGENTS.md`: the Subagents module line gains (a) the recent-window setting,
  (b) the parent-reporting instruction and its honesty note, and (c) the
  drill-in's Details + Result sections. The `RuntimeSettings` / `SubagentTranscript`
  comment corrections land with the types.

## Out of scope

- No record-layer change. Subagent runs remain adapter-owned best-effort state
  (docs/adr/0002, 0007). No new `Run`-like entity, no server-side enforcement.
- No toggle to enable/disable the parent-reporting instruction this pass
  (always-on; a setting can follow).
- No changes to `transport-openclaw` — its `subagentTranscript` capability stays
  `false`; the seam is already in place for a future implementation.
- No new dependencies (the #2 plugin is dependency-free by construction, like its
  three siblings; #1 adds a settings section + dialog field; #3 adds a
  field + a UI section).
