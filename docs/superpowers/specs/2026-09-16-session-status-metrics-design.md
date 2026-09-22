# Session status bar — token usage, context size and model (design)

Date: 2026-09-16
Status: approved

## Goal

Show, in the workbench's bottom status bar, the ACTIVE Session's model route,
token usage and context occupancy — inline as a compact `model · used / window`
readout, and in the existing Session popover as a full breakdown:

- **Model** — the underlying `provider/model` the runtime actually resolved.
- **Context** — the latest turn's context occupancy (`usage.inputTokens`) over
  the model's `contextWindow` (e.g. `12.3k / 128k`).
- **Token usage** — the latest turn's `input/output/total` plus the Session's
  cumulative `input/output/total` over all its Runs.

The data comes from the record (the `Run`s the adapter already persists), so it
survives a reload and is never a fabricated client constant.

## Motivation

The status bar's `SessionStatusChip` (`apps/web/components/studio/status-bar.tsx`)
today shows only the Session title and its record metadata. The runtime already
knows more: the dsh adapter records `parameters.provider/model/usage` on every
Run, and the harness emits the model's `contextWindow` in `request/context`. None
of it reaches the user. A researcher watching a long agent session needs the
context budget in view (is the window about to overflow?) and a running token
tally.

## Scope

In scope:

- dsh adapter: capture `request/context` and record `contextWindow` on Runs.
- Service: optional `?sessionId=` filter on the existing runs route.
- transport-client: a runs fetch helper, a PURE summarizer and a metrics hook.
- Web: store revision bump on run finish; the Session chip inline + popover.

Out of scope (unchanged):

- The seam (`packages/transport`): no `StateDelta`/`WatchSnapshot` change, no new
  adapter method, no live mid-run streaming. The readout refreshes when a run
  settles.
- openclaw: it records neither `provider/model` nor `usage`, so its Sessions show
  `—` for the missing fields. Adding that to the openclaw adapter is a separate
  change.
- The wire fold and SSE protocol.

## Decisions

- **Record is the source.** Metrics are derived from persisted `Run`s via the
  existing `GET /api/projects/:id/runs` route, not streamed over the run channel.
  A fresh page and a reload converge to the same numbers.
- **Capture `contextWindow` from `request/context`, not a bridge call.** The dsh
  harness already logs a `request/context` event whose data is
  `{ provider, model, contextWindow? }` (see `@deepseek-ai/dsh-session`); the
  adapter currently ignores `request/*`. Reading it avoids a new child-socket
  endpoint and a new `llm` injection into the child plugin. When the event (or
  its `contextWindow`) is absent, the adapter degrades silently and the UI omits
  the window.
- **`Run.parameters` carries it.** `parameters` is already
  `Record<string, unknown>` ("e.g. token usage"), so `contextWindow` is additive
  and no record type changes.
- **Aggregate in a pure function, not in a component.** The arithmetic (filter
  by Session, sort, cumulative sums, latest pick, field fallback) is a
  dependency-free function that a unit test drives directly; the React hook is a
  thin fetch wrapper.
- **Refresh on settle, bounded payload.** Add `?sessionId=` to the runs route so
  the status bar fetches only its Session's Runs, not the whole Project's. The
  client refetches when a run finishes (`onFinish` bumps a store revision) and
  when the scope changes.
- **Define the token total once.** `runTotal = usage.totalTokens ?? inputTokens +
  outputTokens`. Cumulative is the sum of `runTotal`; input/output are summed
  independently. This stays correct when a provider reports no aggregate total.
- **Context occupancy is the latest Run's `usage.inputTokens`.** For a
  multi-step turn the adapter's last `assistant/message` wins, which is the
  step whose input is the fullest context — the honest "how full is the window"
  number.

## Components

### `packages/transport-dsh/src/behavior.ts` (extend)

- In `applyEvent`, add a `"request/context"` case: read `event.data`'s
  `provider` / `model` (strings) and `contextWindow` (finite number), and store
  them in a per-Session map keyed by `ctx.sessionKey`. Do not emit any delta.
- In `projectRun(ctx)`, merge the map entry for `ctx.sessionKey` (falling back to
  the adapter's configured `provider`/`model`) into `parameters`:
  `{ provider, model, ...(contextWindow !== undefined ? { contextWindow } : {}),
  ...(usage !== undefined ? { usage } : {}) }`.
- The map is per-adapter (one Project), so it is bounded by the Project's Session
  count; no eviction is needed for v1.

### `services/transport-service/src/server.ts` (extend)

- `GET /api/projects/:id/runs`: read `request.query.sessionId` and filter the
  `listRuns` result when present. No store or contract change.

### `packages/transport-client/src/projects.ts` (extend)

- `fetchSessionRuns(api, projectId, sessionId)` →
  `GET ${api}/<projectId>/runs?sessionId=<sessionId>`; returns `Run[]`.

### `packages/transport-client/src/session-metrics.ts` (new, pure)

- `interface TokenUsage { inputTokens; outputTokens; totalTokens?; cacheReadTokens?;
  cacheWriteTokens?; reasoningTokens? }` (local, validated from `unknown`).
- `interface SessionMetrics { model?: { provider?; model?; contextWindow? };
  latest?: { usage?: TokenUsage; status?: RunStatus; at?: string };
  cumulative: { input: number; output: number; total: number; runs: number } }`.
- `summarizeSessionRuns(runs, sessionId): SessionMetrics`:
  - filter `run.sessionId === sessionId`;
  - order by `finishedAt ?? startedAt` (stable, insertion-order fallback);
  - `latest` = last Run; `cumulative` = sums over all, `total` via the rule
    above; `model` = the most recent Run that carries any of
    `provider/model/contextWindow`, merged so a later incomplete Run does not
    erase an earlier field.

### `packages/transport-client/src/session-metrics.tsx` (new, hook)

- `useSessionMetrics({ api, projectId, sessionId, revision })`:
  - no `projectId`/`sessionId` → no request, returns `null`;
  - fetch on `[api, projectId, sessionId, revision]`; on failure keep the last
    value (never throw), abort on unmount.
- `index.ts` exports `fetchSessionRuns`, `summarizeSessionRuns`, the types and
  the hook.

### `apps/web/store/studio-store.ts` (extend)

- `runsRevision: number` (starts `0`) and `bumpRunsRevision()` (increments).

### `apps/web/components/session-view.tsx` (extend)

- Pass `onFinish: () => useStudioStore.getState().bumpRunsRevision()` to
  `useTransport`. `Session` stays memoized and does not subscribe to the store
  (the callback reads state imperatively), so the runtime-owner re-render
  invariant is preserved.

### `apps/web/components/studio/status-bar.tsx` (extend)

- `SessionStatusChip` subscribes to `runsRevision` and reads the active
  `projectId`/`activeSessionId` from the store, calling
  `useSessionMetrics({ api: DEFAULT_PROJECTS_API, ... })`.
- Inline label: Session title, then `· <model> · <used>/<window>` when known
  (`contextWindow` absent → just `<used>`).
- Popover: the existing Session identity block, then a **Token usage** block —
  latest turn (in/out/total, cache/reasoning when present) and Session cumulative
  (in/out/total + run count) — plus model (`provider/model`) and context
  (`used / window`, occupancy percentage).
- `formatTokens(n)` renders exact integers below 1000 and `12.3k` / `1.2M`
  above.
- Every unknown field renders `—`; a Session with no Runs shows the identity
  block and a muted "no turns yet".

## Data flow

```
dsh request/context ──▶ behavior map ──▶ Run.parameters.contextWindow
run settle ──▶ Run persisted ──▶ GET /api/projects/:id/runs?sessionId=
                                          │
onFinish bumps runsRevision ─────────────┘
                                          ▼
        useSessionMetrics ──▶ summarizeSessionRuns ──▶ StatusBar chip
```

## Error handling

- No scope → no request, chip shows the Session identity only.
- Fetch failure → keep the previous metrics; never surface a toast or throw.
- Unknown/malformed `usage` → ignored (treated as absent), not fatal.
- Missing `contextWindow` → occupancy-only readout.
- openclaw Sessions → identity only, all metric fields `—`.

## Testing

- `packages/transport-client/test/session-metrics.test.ts`: cross-Session
  filtering, cumulative sums, `totalTokens ?? input+output` fallback, missing
  `usage`, latest pick under mixed timestamps, model field fallback across Runs,
  and malformed `usage` ignored.
- `packages/transport-dsh/test/behavior.test.ts`: a `request/context` event is
  captured and lands in `Run.parameters.contextWindow`; with no such event the
  field is absent and the Run still persists.
- `services/transport-service/test/projects.test.ts`: `?sessionId=` filters the
  runs listing and no query still returns every Run.
- `npm run build` — the real type gate (includes `typecheck:tests`).

## Risks

- **`request/context` timing** — if a harness release never emits it, only the
  window is missing; occupancy and usage still render. The adapter must not treat
  the absence as an error.
- **Per-step vs cumulative usage** — `Run.parameters.usage` is the turn's LAST
  step (the kit's `note` overwrites per `assistant/message`). The design names
  this explicitly ("latest turn", occupancy = last step's input) so the numbers
  are not misread as a per-run aggregate.
- **Runs list growth** — filtering server-side bounds the status-bar payload;
  the record itself still accumulates every Run (unchanged, and expected).

## Amendment (2026-09-23): per-turn usage is the billed tally, occupancy is the prompt

The two bullets above ("Context occupancy is the latest Run's
`usage.inputTokens`" and the per-step `note` overwrite in Risks) rest on wrong
premises, verified against the pinned harness contract (`TokenUsage` in
`@deepseek-ai/dsh-llm`) and the harness's own token-meter projection:

- The usage counts are DISJOINT: `inputTokens` covers only UNCACHED input;
  cached prompt traffic rides `cacheReadTokens`/`cacheWriteTokens` (billed
  input is the sum of the three). So the Context gauge reading bare
  `inputTokens` under-states occupancy exactly when caching matters, and the
  popover's `in / out / total` rows do not reconcile (the provider `totalTokens`
  counts the cache buckets).
- The turn's LAST step (the kit's one-slot-overwrite `note`) dropped every
  earlier step of an agent loop, so no "total" row was a running tally.

What ships instead:

- The dsh adapter folds each turn's usage with the token-meter's own rules
  (`packages/transport-dsh/src/usage.ts`): sum the disjoint buckets across every
  `assistant/message` and settled `assistant/attempt`; a repeated
  `(turn, step)` replaces its contribution; `llm/retry-started` closes the slot
  so a retried attempt adds. The aggregate is persisted as
  `Run.parameters.usage`, and the newest sample's prompt size (uncached input +
  cache traffic) as `Run.parameters.contextTokens`.
- The client summarizes billed input (uncached + cache), derives a per-run
  total that reconciles with the rows beside it, and reads `contextTokens`
  (falling back to the latest usage's prompt for pre-amendment records) for the
  Context gauge.
