# Subagent (DSH) run status in the Subagents panel (design)

Date: 2026-09-17
Status: approved

## Goal

Populate the workbench's **Subagents** module
(`apps/web/components/studio/subagents-view.tsx`, today a pure empty-state
skeleton) with the **live status of dsh subagent runs** — the delegated agent
runs a Session's agent spawns. The panel shows, per subagent run, its label,
spawn provider, status, stop reason, start/finish time and elapsed duration.

This is **live-only**: the list is assembled in the adapter from runtime events
and is never persisted. A service restart empties it. Tracking past subagent
runs is a separate, larger feature and is out of scope.

## Motivation

The Subagents module was built as a shell so the right pane's shape would exist
before its data source did (docs/superpowers/specs/2026-09-17-right-panel-collapsible-sections-design.md).
The dsh runtime already emits the signal: the pinned SDK protocol carries
`subagent.started` and `subagent.finished` notifications, and a child session's
log carries a `subagent/descriptor` event. Today every one of those is
**discarded** at the adapter boundary — `packages/transport-dsh/src/client.ts`
forwards only root `session.event` notifications (`client.ts:91-96`), so no
subagent signal reaches Science Studio at all. This design captures that signal
and renders it.

## Scope

In scope:

- Adapter capture of subagent lifecycle notifications and descriptor events.
- A new optional `RuntimeAdapter` surface + a normalized `SubagentRun` view type
  in the contract package.
- A service read route and its web proxy.
- A client polling hook and the panel UI.
- Tests at each layer and an ADR.

Out of scope (unchanged):

- Persistence of any kind. No record-layer field or entity, no `Run`
  relationship, no disk mirror. Restart resets the list.
- Drilling into a subagent's transcript. The pinned SDK has no child-history
  replay and the adapter's mirror is per root session, so this would be a
  substantial separate design.
- Cancelling/steering a running subagent, listing remote (ACP) subagents, and
  the harness's richer `SubagentCatalog` / timing projections.
- Cron and Files modules, the transcript watch protocol, and the transport kit.

## Decisions

- **Live-only, adapter-owned, in memory.** The registry lives in the dsh adapter
  for exactly one child generation. It is dropped on adapter release and never
  written to the record. This matches the request ("运行历史状态" = the status of
  subagent runs) without inventing deferred record vocabulary (docs/adr/0007).
- **The seam gains one OPTIONAL method, not a new channel.** Subagents are a
  runtime capability; the service route stays runtime-agnostic by asking
  `RuntimeAdapter.subagents?` and degrading to an empty list when it is absent —
  the `listCommands?` / `subscribe?` pattern. A per-runtime concept does not
  belong in the transcript watch, and extending `WatchSnapshot` / `StateDelta`
  would couple the shared kit to subagent state it does not own.
- **The service pulls; the panel polls.** The state is a small list read on
  demand. A dedicated `GET` route reuses the existing proxy policy, needs no
  changes to the watch protocol, and is trivially testable. Polling is enabled
  only while the module is open and a Session is active.
- **The adapter stamps time and joins labels.** The SDK wire carries no
  timestamps, so the adapter stamps `startedAt` / `finishedAt` on arrival. The
  label is best-effort: the child's `subagent/descriptor` supplies it when the
  harness emits one; otherwise the row falls back to a short child id.
- **Remote subagents are a documented limitation.** The harness reports
  `subagent.finished` only for `local` (in-process) children; ACP/remote runs are
  never announced. The panel will not show them.

## Components

### `packages/transport/src/types.ts` (edit) — the view type

```ts
/**
 * One delegated (subagent) run as a runtime reports it. LIVE state: assembled
 * by the adapter from runtime events and never persisted.
 */
export interface SubagentRun {
  /** Runtime-assigned child identity (dsh: the child session id). */
  id: string;
  /** The Science Studio Session this run was delegated from. */
  parentId: string;
  /** Best-effort display label (dsh: the child's descriptor label). */
  label?: string;
  /** Spawn mechanism / provider name (dsh: "spawn" | "fork"). */
  provider?: string;
  /** Reuses the record's Run status vocabulary. */
  status: RunStatus;
  /** Richer runtime stop reason when one exists (dsh: max-tokens, refusal, …). */
  stopReason?: string;
  /** ISO timestamps stamped by the adapter (the wire carries none). */
  startedAt: string;
  finishedAt?: string;
}
```

`RunStatus` is imported from `@science-studio/record` (already the source of
`Run` in this file), so the panel's badges share the Run vocabulary.

`RuntimeAdapter` gains:

```ts
/**
 * Live subagent runs delegated from one canonical session key. OPTIONAL: gate
 * on `capabilities.subagents` rather than forcing a no-op on every runtime.
 */
subagents?(sessionKey: string): Promise<SubagentRun[]>;
```

`RuntimeCapabilities` gains `subagents: boolean`. Both new types are
re-exported through `./seams` and the package root; the source of truth is
`types.ts` / `runtime.ts` and the export lists are updated explicitly (no
`export *`).

### `packages/transport-dsh/src/subagents.ts` (new) — the registry

A small class that folds notifications into a `Map<childSessionId, Entry>`:

- `noteStarted({ parentSessionId, childSessionId })` — insert an entry
  `{ harnessId: childSessionId, parentHarnessId: parentSessionId,
  status: "running", startedAt: now() }`.
- `noteDescriptor(childSessionId, descriptor)` — enrich `label` and `provider`
  from the child's `subagent/descriptor` session event.
- `noteFinished({ provider, parentSessionId, childSessionId, status, stopReason })`
  — set `status` (`ok` → `completed`, `error` → `error`), `stopReason`,
  `finishedAt`, `provider`.
- `list(sessionKey)` — for each entry, walk the registry's own parent lineage
  (`child → parent → … → root`) to find its root harness session id,
  reverse-map that root through the adapter's `harnessSessions` map to a Science
  Studio session key, and return the entries for `sessionKey`, newest
  `startedAt` first, mapped to `SubagentRun`. `SubagentRun.parentId` is that
  root's Science Studio session key (the Session the delegation belongs to);
  `SubagentRun.id` is the child harness id.
- `pruneRoots(liveRoots)` — drop entries whose root no longer maps, called when
  the adapter remints a session id (`/new`) or otherwise changes the map.
- An injected `now()` (default `() => new Date().toISOString()`) keeps tests
  deterministic.

The registry is dependency-free of `@deepseek-ai/*` types beyond the
notification payloads it is handed, so a harness pin that moves the shapes
degrades to an unlabeled/empty entry rather than a crash.

### `packages/transport-dsh/src/client.ts` (edit) — the standing subscription

`DshTurnClient` gains:

```ts
/** Subscribe to the runtime's notifications for the whole child (all
 *  sessions). Returns an unsubscribe. Best-effort: a runtime that never
 *  starts simply never delivers. */
subscribeNotifications(listener: (notification: HarnessNotification) => void): () => void;
```

`SdkDshTurnClient` implements it with `this.harness.client.subscribe()` (the
high-level `DeepSeekHarness` exposes its `client`, `api.d.ts`). The listener is
called for every notification; the registry decides what matters. The existing
`runTurn` filter is unchanged — the transcript path stays root-only.

### `packages/transport-dsh/src/adapter.ts` (edit) — wiring

- After `ensureStarted()` resolves, attach the subscription **once** and feed
  the registry. A failed start leaves the registry empty; the next start retries.
- Parse notifications:
  - `subagent.started` → `noteStarted`
  - `subagent.finished` → `noteFinished`
  - `session.event` with `event.type === "subagent/descriptor"` → `noteDescriptor`
- `subagents(sessionKey)` → `registry.list(sessionKey)`.
- `DSH_CAPABILITIES.subagents = true`.
- On `/new` (the session id remint), prune the registry with the new root set.

### `packages/transport/src/runtime.ts` (edit) — capabilities

Add `subagents: boolean` to `RuntimeCapabilities`, documented as
"`RuntimeAdapter.subagents()` is available". `transport-openclaw` and every
other implementation set it `false`.

### `services/transport-service/src/server.ts` (edit) — the read route

```
GET /api/transport/subagents?projectId=&threadId=
```

Follows the commands route's shape (`server.ts:357-370`):

- `scope.acquire(request)` → the Project's adapter (one per Project,
  docs/adr/0008).
- If `typeof adapter.subagents !== "function"` → `{ subagents: [] }`.
- Resolve the canonical key with `canonicalSessionKey(adapter, threadId)` (no
  Session row is minted — the same rule as watch).
- `await adapter.subagents(sessionKey)`; on throw, log and answer
  `{ subagents: [] }`.

### `apps/web/app/api/transport/subagents/route.ts` (new) — the proxy

Relays the query through `proxyToService` (verbatim status/body, forwarded
auth) and maps a non-2xx upstream to `{ subagents: [] }`, mirroring
`transport/commands/route.ts`. `runtime`/`dynamic` stay literal in the file.

### `packages/transport-client/src/subagents.ts` (new) — fetch + hook

```ts
export async function fetchSubagents(
  api: string,
  scope: { projectId: string | null; threadId: string | null },
): Promise<SubagentRun[]>;

export function useSubagents(options: {
  api: string;
  projectId: string | null;
  threadId: string | null;
  enabled: boolean;
  intervalMs?: number; // default 1500
}): { subagents: SubagentRun[] };
```

The hook runs one polling effect: an `AbortController` aborted on unmount and on
any dependency change, a `setInterval` at `intervalMs`, and a local list that is
replaced only on a successful, non-aborted fetch (a failed poll keeps the last
good list). `enabled: false` makes no requests. Exports are added to
`src/index.ts`.

### `apps/web/components/studio/subagents-view.tsx` (edit) — the panel

- Read `projectId` and `activeSessionId` from `studio-store`.
- `enabled: open && activeSessionId !== null`.
- Render rows newest-first: a status badge (`running` / `completed` /
  `aborted` / `error`), the label (fallback: short child id), the provider
  (`spawn` / `fork`), `stopReason` when present, and start time + elapsed.
- Keep the existing neutral `ModuleEmptyState` when the list is empty; a failed
  fetch degrades to the same quiet state (no error banner).
- `RightPanel` is unchanged — it already renders `SubagentsView`.

## Data flow

Runtime child → `HarnessClient.subscribe()` → `DshTurnClient.subscribeNotifications`
→ `SubagentRegistry` (adapter, in memory) → `GET /api/transport/subagents` →
web proxy → `useSubagents` (poll) → `SubagentsView`. The transcript path
(`runTurn`) is untouched; subagent signal never flows through the watch.

## Error handling

- A runtime without a subagent surface: route and proxy answer
  `{ subagents: [] }`; the panel shows the empty state.
- A throw in `adapter.subagents`: logged, answered empty; the panel stays quiet.
- A failed or aborted poll: the last good list is kept; no error UI.
- A missing `finished` (killed child, restart): the entry stays `running` until
  the registry is dropped; no synthesized completion.
- A stale root (`/new`, restart): pruned from `list()`, never an orphan row.
- The subscription is best-effort: a child that never starts simply has no
  entries.

## Testing

- `packages/transport-dsh/test/subagents.test.ts` — registry unit test with
  scripted notifications: start → running, descriptor → label/provider,
  finish → status/stopReason, injected-clock timestamps, lineage →
  session-key filtering, stale-root pruning, newest-first order. Also asserts
  the adapter wires the subscription after start and advertises
  `capabilities.subagents`.
- `packages/contract-tests` — a new optional suite (`testSubagents`), run by
  implementations that advertise `capabilities.subagents` (transport-dsh
  self-tests here), pinning the method's contract.
- `services/transport-service/test` — the route returns the adapter's list, and
  `{ subagents: [] }` when the method is absent or throws.
- `apps/web/test/subagents-panel.test.mjs` — Chromium-gated like the other web
  tests: mock `/api/transport/subagents`, assert rows and status text render,
  the empty state shows for an empty list, and no request fires while the
  module is collapsed.
- `npm run build` is the type gate (includes `typecheck:tests`).

## Docs

- New ADR `docs/adr/0016-subagent-activity-is-an-optional-adapter-surface.md`:
  the optional-method choice over a watch extension, live-only semantics, the
  adapter-stamped timestamps, and the remote-subagent limitation.
- This spec.
- A short `AGENTS.md` note: the Subagents module is fed by the optional
  `RuntimeAdapter.subagents?` surface (dsh implements it live-only), polled via
  `/api/transport/subagents` and `useSubagents`.

## Risks

- **Harness notification shapes can drift.** The registry reads
  `subagent.started` / `subagent.finished` / `subagent/descriptor` payloads
  structurally and fails soft (unlabeled entry, no crash). The pinned SDK makes
  a drift a deliberate upgrade, covered by the registry test.
- **Polling load.** 1.5 s per open, active Session against a local service is
  negligible; `enabled` keeps a collapsed module at zero requests. If the list
  grows or a push channel later exists, the hook is the one place to swap.
- **Background subagents and the run channel.** A background child can outlive
  the parent turn, but the registry is fed by a child-wide subscription, not the
  per-run stream, so its status keeps updating until `finished` arrives — the
  reason this design does not reuse `SessionRuntime.subscribe`.
- **Root lineage mapping.** A root harness id not in `harnessSessions` (a
  harness session created outside this adapter) cannot be attributed to a
  Science Studio Session and is skipped rather than mis-bucketed.
