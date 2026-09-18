# Subagent history, display names, and child-session drill-in — design

## Problem

1. **Completed subagent runs vanish.** The dsh `SubagentRegistry` is in-memory and
   dropped with the adapter (ADR 0016 recorded "live-only; a restart empties the
   panel by design" when the panel needed *a* data source). That decision
   predated ever seeing the panel with real history: in practice the only
   reliable way to look at past delegations is *after* the fact — usually after
   a service restart — and the list is then empty.
2. **No history surface.** The panel mixes running and finished runs with no
   way to separate them; there is no "show me what ran here before".
3. **Unreadable names.** When the harness reports no descriptor `label` (a
   one-shot child's label is optional), the row falls back to the raw child
   session id (a UUID or a minted `sess-…` string).
4. **No drill-in.** A delegation is only visible through its parent turn; the
   child's own conversation (its prompt, tool work, result) is never
   reachable from the workbench, though the harness persists it in its own
   session log.

## Decisions

### D1 — The dsh adapter keeps a durable, per-Session subagent ledger

The adapter already owns one piece of its own durability (the `TranscriptMirror`
under the transcript dir); the subagent ledger gets the same treatment:

- **Owner**: `@science-studio/transport-dsh`. The record
  (`Project`/`Session`/`Run`) stays authoritative and untouched — a subagent
  run is adapter-owned activity, per ADR 0002's record/runtime split.
- **Location**: `<transcript dir>/subagents/<percent-encoded session key>.json`,
  one file per Science Studio Session (the dir is shared by all of a
  deployment's per-Project adapters, so the file is keyed by the record-owned
  session key — the same rule as the transcript mirror's one-file-per-session).
- **Lifecycle**: the registry stamps each entry with its resolved
  `sessionKey` the first time the parent harness id resolves, and persists on
  every mutation (started / descriptor / finished / key-stamp) via an atomic
  rename, writes chained so concurrent saves never interleave.
- **Restore**: on adapter init the registry hydrates from the files present
  for the dir. A restored entry that was still `running` is settled to
  `aborted` (its harness child died with the previous process; reading it as
  running would be a lie). In-memory entries always win over a restored one
  with the same id.
- **Robustness**: `subagent.finished` for a child whose `subagent.started` was
  never observed (a missed notification, or a service restart mid-run) still
  creates the entry, linked through the finished payload's own
  `parentSessionId`; `startedAt` is then stamped at observation time
  (best-effort — the wire carries no timestamps, the adapter always stamps).

This deliberately re-scopes (not reverses) ADR 0016: the surface stays an
optional adapter method; what changes is dsh's durability policy, and the ADR
gets an addendum.

### D2 — Panel: live by default, history opt-in

- Default view = `running` entries only (the "what is happening now" module).
- A History toggle (header action, `aria-pressed`) additionally shows the
  finished entries (completed / aborted / error), newest first, including
  restored ones.
- The toggle is chrome state in the studio store (in memory, like every other
  panel state; reload returns to the default).
- Empty state adapts: with nothing running but hidden history, the hint names
  the hidden count and points at the toggle instead of "No subagents yet".

### D3 — Names: the label when it reads like a label

Rows use the descriptor `label` when it is human text; everything else (no
label, or a label that is itself an id — a UUID, a long opaque token) falls
back to an ordinal display name, "Subagent A / B / C" in the list's order.
The raw id is kept in the `title` tooltip and remains `run.id` on the wire.
No new wire field: this is a presentation rule in the panel.

### D4 — Double-click a row opens the child session in the tab system

- **Seam**: one new optional `RuntimeAdapter` member,
  `subagentTranscript?(sessionKey, childId) → SubagentTranscript | null`,
  plus a `RuntimeCapabilities.subagentTranscript` flag enforced to match
  method presence by the factory conformance suite — the exact discipline of
  the existing `subagents?` member. `null` = "the runtime has no record for
  this child"; an absent method = runtime without the surface.
- **dsh implementation**: read the harness's own child session log. The child
  is stored by the harness at
  `<dsh home>/sessions/<projectKey(cwd)>/<childId>/session.v<n>.jsonl.zstd`,
  where `projectKey` is the harness's lossy path slug and `<cwd>` is the
  launch working directory the adapter already computed. The reader:
  - re-implements `projectKey` (a ~30-line pure function: separators → `-`,
    unsafe code units `~XXXX`, `--…--` bracketing, 251-char bound) and
    enumerates the child dir for the newest `session.v<n>.jsonl` artifact —
    either the uncompressed `.jsonl` or the zstd-framed `.jsonl.zstd` — so a
    harness format bump degrades to "no record" instead of a crash;
  - decodes the framed artifact with Node's built-in `zlib` (no new
    dependency) and folds the committed events with the package's existing
    mapping helpers
    (`contentToParts`, `extractResultText`, `findToolCallMessage`):
    `user/message` → user rows, `assistant/message` → assistant rows,
    `tool/call` + `tool/result` merged into the owning assistant row,
    `turn/end` → the row's terminal status, `subagent/descriptor` → label /
    model fields. `session`-header lines, sandbox/approval metadata and the
    request/step events are structural, never rendered.
  - is fail-soft end to end: no file, unreadable frame (a still-running child's
    torn tail), or a rejected format → the transcript is `null`, and the UI
    shows a friendly "record unavailable" instead of an error state.
- **Service**: `GET /api/transport/subagents/:childId/transcript?projectId&threadId`
  on the shared service (scope claim exactly like the existing subagents
  route). No adapter method → 404; `null` answer → 404; child id validated as
  a single safe path segment. The child id is the ledger entry's id (the
  harness child session id), stable across restarts because it is persisted
  with the entry (D1).
- **Web**: one new proxy hop under the same one-policy relay as its siblings
  (`apps/web/app/api/transport/subagents/[childId]/transcript/route.ts`); a
  `fetchSubagentTranscript` / `useSubagentTranscript` hook in
  `@science-studio/transport-client`; and the workbench tab system gains ONE
  synthetic tab kind, `subagent:<childId>` (the same pattern the cron-task
  renderer already rides): `SubagentsView` rows `onDoubleClick` call a new
  `openSubagent(childId, name)` store action, the tab strip renders it with
  a bot icon, and the preview pane dispatches it to a new
  `SubagentRenderer` (own header: title + close, no download affordance)
  before any file logic. All existing tab invariants (mounted-across-switch,
  cleared on Project switch) apply untouched, and a real workspace path can
  never collide with the synthetic namespace.

### D5 — Wire shape

```ts
export interface SubagentTranscript {
  id: string;                 // the child session id (= SubagentRun.id)
  parentId: Id;               // the delegating Session key
  label?: string;             // descriptor label
  provider?: string;          // establishing provider (spawn/fork/…)
  agentProvider?: string;     // descriptor model routing, when recorded
  agentModel?: string;
  startedAt?: string;         // from the stored session header, when present
  finishedAt?: string;        // from the log's end, when present
  status?: RunStatus;         // the child's terminal outcome, when the log ends
  messages: Message[];        // the canonical Message/MessagePart vocabulary
}
```

`SubagentRun` is unchanged. The `RuntimeAdapter.subagents?` and
`SubagentRun` doc comments are corrected to say the list is best-effort live
state that a runtime MAY remember durably — never a record (ADR 0002).

## Components

| Change | Where |
| --- | --- |
| `sessionKey` stamping, `attachStore`, restore + settlement, finished-missing-entry, keyed persistence | `packages/transport-dsh/src/subagents.ts` |
| `FileSubagentLedger` (dir listing / load / atomic save, one file per session key) | `packages/transport-dsh/src/ledger.ts` (new) |
| `projectKey` + zstd log reader + event fold | `packages/transport-dsh/src/child-transcript.ts` (new) |
| `subagentTranscript()` implementation, ledger attach in `initialize()`, `parentSessionId` passthrough, the launch `dshHome` + `cwd` kept for transcript reads | `packages/transport-dsh/src/adapter.ts` |
| `SubagentTranscript` type, `subagentTranscript?` member, `capabilities.subagentTranscript`, `SubagentRun` doc fix | `packages/transport/src/{types,runtime}.ts` |
| capability flags (dsh `true`, openclaw `false`), fixtures | `packages/transport-dsh/src/binding.ts`, `packages/transport-openclaw/src/binding.ts`, service fixtures |
| conformance: factory capability/method match for the new flag | `packages/contract-tests/src/runtime-factory.ts` |
| transcript route (scope + capability + 404s) | `services/transport-service/src/server.ts` |
| `openSubagent` action + `subagentsShowHistory` flag | `apps/web/store/studio-store.ts` |
| History toggle, running-only default, name rule, empty-state hint, double-click | `apps/web/components/studio/subagents-view.tsx` |
| synthetic-tab dispatch + bot icon | `apps/web/components/studio/{tab-strip,file-preview-pane}.tsx`, `renderers/SubagentRenderer.tsx` (new) |
| proxy hop | `apps/web/app/api/transport/subagents/[childId]/transcript/route.ts` (new) |
| fetch hook | `packages/transport-client/src/subagents.ts` |

## Error handling

- Every adapter-side I/O failure (ledger read, log decode) is logged and
  surfaced as *absence*, never as a thrown error into a route: the panel keeps
  polling a good list, the transcript route answers 404, the renderer shows
  the friendly state.
- A `subagent.*` notification of an unrecognized shape is still ignored
  structurally (the existing rule is unchanged).
- The transcript read is a plain same-origin GET with the one-policy proxy;
  no SSE, no long-lived socket.

## Tests

- **registry** (`transport-dsh/test/subagents.test.ts`): fake in-memory store —
  restore + stale-`running`→`aborted` settlement, key-stamp persistence,
  finished-without-started creates the entry, per-key save scoping, live-entry
  precedence over restore.
- **adapter** (`transport-dsh/test/adapter.test.ts`): a finished subagent is
  listed by a SECOND adapter instance over the same transcript dir (the
  restart scenario); a `subagentTranscript` read over a real zstd-built child
  log fixture returns user/assistant/tool rows and the descriptor fields;
  unknown child id → `null`.
- **conformance** (`contract-tests`): factory capability matches method
  presence.
- **service** (`transport-service/test/subagents.test.ts`): transcript route —
  absent surface 404, `null` 404, well-formed 200, unknown child 404.
- **web** (`apps/web/test/subagents-panel.test.mjs`): default view shows only
  the running row; the toggle reveals the completed row with its friendly
  name; double-click opens a `subagent:` tab whose renderer shows the
  (mocked) transcript text; collapsed still polls nothing.

## Docs

- ADR 0016 addendum (durability re-scoped; drill-in is adapter-owned).
- `AGENTS.md`: the Subagents module line stops saying "live-only / never
  persists" and names the ledger, the toggle, and the drill-in route.
- `SubagentRun` / `subagents?` comments corrected (D5).

## Out of scope

- No record-layer entity, no `Run` projections for subagents (ADR 0007 v1
  vocabulary untouched).
- No transcript drill-in for openclaw (capability `false`; the seam is ready).
- No multi-user/enterprise behavior beyond the existing single-user surface.
