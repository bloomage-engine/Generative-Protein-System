# SessionRuntime Migration Plan

Status: implemented (S1–S4 landed; see docs/adr/0005). Audience: maintainers of `packages/transport`,
`packages/transport-openclaw`, `packages/transport-dsh`,
`packages/contract-tests`. Decision record: [`docs/adr/0005`](../adr/0005-runtime-adapters-compose-a-shared-session-runtime.md).
Vocabulary: `codebase-design` (module / interface / seam / adapter / depth /
leverage / locality). Domain terms: `/CONTEXT.md`.

This document turns ADR-0005 into a file-level, slice-by-slice plan. The target
is already decided; this is the *how*. The overriding constraint is that the
public `RuntimeAdapter` seam, its factory/plugin registration, and every
existing public-surface test keep working untouched — each slice below is
independently releasable and rolls back on its own.

---

## 1. Target interface (recap)

New kit module `packages/transport/src/session-runtime.ts` (KIT tier — exported
from the package root, **never** from `./seams`). Composition, not inheritance:

```ts
interface SessionBehavior<E> {
  apply(event: E, ctx: ApplyContext<E>): ApplyResult | void;   // required: event -> deltas
  dispatch(req: DispatchRequest, run: RunControl<E>): Promise<void> | void; // required: launch surface
  prepare?(h: TranscriptHandle): Promise<void> | void;          // openclaw history / dsh mirror restore
  beforePersist?(ctx: SettleContext): Promise<void> | void;      // dsh mirror save
  projectRun?(ctx: SettleContext): Partial<RunSpec> | null;      // null = persist nothing
  watch?: { coalesceMs?: number; readBaseline?(key: string): Promise<WatchSnapshot | null> };
  awaitSettle?: boolean;                                         // default true
}

class SessionRuntime<E> {
  constructor(sessionKey: string, behavior: SessionBehavior<E>, deps: SessionRuntimeDeps);
  run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta>;
  ingest(event: E): void;
  subscribe(sink: (s: WatchSnapshot) => void): () => void;
  abort(reason?: string): void;
  get state(): SessionState;
}
```

One `SessionRuntime` per Session; the adapter holds `Map<sessionKey,
SessionRuntime<E>>` and delegates `run`/`subscribe`/`abort`. The kit owns the
run-loop skeleton, the settle pipeline (with error containment), the watch
registry, the Run projection default, the tool-part merge primitive, and the
transcript-equality rule. Adapters keep event mapping, the launch surface, and
only the policy hooks their runtime genuinely differs on.

---

## 2. Slices

Conventions: **A** = add, **M** = modify, **D** = delete.

### S1 — kit lands, adapters untouched

| | File | Change |
| --- | --- | --- |
| A | `packages/transport/src/session-runtime.ts` | `SessionRuntime`, `SessionBehavior`, `ApplyContext`/`RunControl`/`DispatchRequest`/`TranscriptHandle`/`SettleContext`/`WatchPolicy`/`RunSpec`/`ApplyResult`/`SettleDirective`. Internally uses `RunFlow`; `ctx.emit` = fold + push; `ensureMessage`/`mergeToolCall`/`restore` primitives; default Run projection; settle pipeline (project → `addRun` → `beforePersist` → notify) with every failure contained; watch registry + injectable `schedule`. |
| M | `packages/transport/src/fold.ts` | Add `sameConversation(a, b)`: ignores ids, compares `role`, neutralizes `file`/`artifact` (the gateway history cannot observe a client file chip). `sameMessages` unchanged (wire reconcile). |
| M | `packages/transport/src/index.ts` | Export the new kit values (`SessionRuntime`, `sameConversation`, `textOutput`, `mergeToolResult`). `Transcript`/`RunFlow` stay exported this slice (dsh still uses them). |
| M | `packages/transport/test/seams.test.ts` | Add the new kit values to `NON_CONTRACT_NAMES`. |
| A | `packages/transport/test/session-runtime.test.ts` | Fake behavior + scripted feed + injected scheduler: reconcile-first ordering, probe termination, user echo + single `running`, flow drain, default/partial/`null` projection, `addRun` failure containment, watch baseline/coalesce/unsubscribe, remote settle (terminal with no flow), abort-then-late-settle, `ctx.targetRunId` filtering. |

`packages/transport/test/transcript.test.ts` stays this slice; it is retired in
S4.

### S2 — openclaw migrates

| | File | Change |
| --- | --- | --- |
| A | `packages/transport-openclaw/src/behavior.ts` | `openClawBehavior(deps)`. `apply` migrates from `SessionTranscript.apply`/`applyThinkingPart`/`applyToolPart`, using `ctx.ensureMessage`/`ctx.mergeToolCall`/`ctx.emit` and reading `ctx.targetRunId` for frame filtering. `dispatch` = `chat.send` loop, `run.targetRunId`, command-run tracking. `prepare` = `chat.history` + `decideHistorySync` → `ctx.restore`. `beforePersist` = local immediate / remote converge-first. `projectRun` = command guard → `null`, else default `completed`. `watch: { coalesceMs: 250 }`. `awaitSettle: false`. |
| M | `packages/transport-openclaw/src/index.ts` | Adapter holds `Map<sessionKey, SessionRuntime<EventFrame>>`; delete the `SessionTranscript` class, the `transcripts`/`watch`/`watchTimers` tables, `persistRun`, `convergeSettledHistory`, `snapshotOf`, `notifyNow`. `gateway.onEvent` routes to `runtime.ingest`; `run`/`subscribe`/`abort` delegate. `listCommands`/`resolveSessionKey`/`approve`/`init` unchanged. |
| M | `packages/transport-openclaw/src/history-sync.ts` | Delete `messageSignature`; `decideHistorySync` uses the kit's `sameConversation`. |
| M | `packages/transport-openclaw/src/tool-result.ts` | Delete `findToolCallIndex`/`mergeToolResult` definitions; import `mergeToolResult` from the kit. Keep `formatResultText`/`TOOL_RESULT_ROLES`/`attachHistoryToolResult`. |
| M | `packages/transport-openclaw/src/mapping.ts` | Import `mergeToolResult` from the kit; no logic change. |

Test moves:

- **Must pass unmodified** (the behaviour-preservation proof): `test/subscribe.test.ts`, `test/transcript-sync.test.ts`, `test/history-converge.test.ts`, `test/attachments.test.ts`, `test/slash-command.test.ts`, `test/sessionkey.test.ts`, `test/conformance.test.ts`.
- **M** `test/history-sync.test.ts`: add role-sensitive and `file`-neutral cases via `sameConversation`.
- **M** `test/tool-result.test.ts`: drop the `findToolCallIndex` assertions (they move to the kit); keep `formatResultText`/`TOOL_RESULT_ROLES`/`attachHistoryToolResult`/`parseParts`.

### S3 — dsh migrates

| | File | Change |
| --- | --- | --- |
| A | `packages/transport-dsh/src/behavior.ts` | `dshBehavior(deps)`. `apply`: `turn/start`, `turn/end` → `ctx.run?.note({ usage })` + `settled: { status }`, `assistant/message`, `tool/result` via `ctx.mergeToolCall`. `dispatch` = `runTurn` + create-only retry (one prompt per run). `prepare` = `ensureStarted` + cold-start mirror restore. `beforePersist` = `mirror.save`. `projectRun` = reason → status, `provider`/`model`/`usage`, baseline slice via the kit's `textOutput`. `watch: { readBaseline }`. |
| M | `packages/transport-dsh/src/adapter.ts` | Adapter holds `Map<sessionKey, SessionRuntime<SessionEvent>>`; delete `transcripts`, `activeFlows`, `settleRun`, `snapshotOf`, `notifySettled`, `transcriptFor`. Keep `init`, `harnessSessions`, `mirror`, `client`, `resolveSessionKey`. |
| M | `packages/transport-dsh/src/mapping.ts` | Move `runStatus` here from `turn.ts`; rename `findToolCallPart` → `findToolCallMessage` (the behavior needs the owning message for `ctx.mergeToolCall`). |
| M | `packages/transport-dsh/src/index.ts` | Drop `export { DshTranscript }` / `ApplyMeta`. Keep `TranscriptMirror`. |
| D | `packages/transport-dsh/src/transcript.ts` | `DshTranscript` retired. |
| D | `packages/transport-dsh/src/turn.ts` | `Turn`/`runOutput` retired (`runStatus` already moved). |

Test moves:

- **Must pass unmodified**: `test/adapter.test.ts`, `test/watch.test.ts`, `test/sessionkey.test.ts`, `test/conformance.test.ts`.
- **D** `test/transcript.test.ts` → `apply`-mapping assertions move to a new `test/behavior.test.ts` (against a fake `ApplyContext`).
- **D** `test/turn.test.ts` → `runOutput` assertions move to the kit's `textOutput` test; `runStatus` to a new `test/mapping.test.ts`; `Turn` bookkeeping is superseded by the kit's `RunControl` tests.
- **A** `test/behavior.test.ts`: `assistant/message` → parts, `tool/result` merge, `turn/end` → directive/status/usage.
- `TranscriptMirror` coverage is retained (`adapter.test.ts` already constructs it directly).

### S4 — retire the old kit shape + shared lifecycle suite

| | File | Change |
| --- | --- | --- |
| M | `packages/transport/src/transcript.ts` → `run-flow.ts` | Delete the `Transcript` class; keep `RunFlow` and **drop its `targetRunId` field** (filtering now rides `ctx.targetRunId`/`RunControl.targetRunId`). |
| M | `packages/transport/src/index.ts` | Stop exporting `Transcript`; keep `RunFlow` (the service's wire regression test is a real caller). Keep `foldState`/`sameMessages`/`sameConversation` and the new kit names. |
| M | `packages/transport/test/seams.test.ts` | Remove `Transcript` from `NON_CONTRACT_NAMES`; keep `RunFlow`. |
| D | `packages/transport/test/transcript.test.ts` | Superseded: `Transcript` tests drop; the queue semantics move to a new `packages/transport/test/run-flow.test.ts`; the reconcile deep-copy assertion moves to `session-runtime.test.ts`. |
| M | `packages/transport/test/fold.test.ts` | Keep the `sameMessages` cases; add `sameConversation` cases. |
| A | `packages/contract-tests/src/adapter-lifecycle.ts` | `testAdapterLifecycle(name, make)`, contract-only (imports `RuntimeAdapter`/`RecordStoreLike` from `./seams`, never the kit). Asserts reconcile-first + probe termination, `subscribe` baseline, a driven turn persisting a Run through the fake store, and abort not hanging. The scripted runtime driver is supplied by each adapter's own `test/` so no test helper leaks into a package's `src` surface. |
| M | `packages/contract-tests/src/index.ts` | Export `testAdapterLifecycle` and its case type. |
| M | `packages/transport-openclaw/test/conformance.test.ts`, `packages/transport-dsh/test/conformance.test.ts` | Also run `testAdapterLifecycle` with each adapter's driver. |
| M | `AGENTS.md` | Structure line for `packages/transport` (kit list becomes `SessionRuntime` + helpers); the "Adapters share one fold-and-fan-out kit" architecture rule; the `packages/contract-tests` line (add `testAdapterLifecycle`). |
| M | `docs/architecture.md` §4 | Remove the "migration in progress" note added alongside ADR-0005. |

---

## 3. Green gates

Every slice ends on the same gate, from the repo root:

```
npm run build            # the real type gate (record -> ... -> transport-service)
npm test                 # all workspaces' suites
```

Plus, while working inside a slice, the focused suite:
`npm test -w @science-studio/transport` / `-w @science-studio/transport-openclaw`
/ `-w @science-studio/transport-dsh` / `-w @science-studio/contract-tests`.

`npm run typecheck` is a known-broken gate (pre-existing TS6310 in
`transport-service`); use `npm run build`.

---

## 4. Out of scope

- **The `RuntimeAdapter` interface itself** (`types.ts`) is unchanged, as is
  `RuntimeFactory`/`RuntimePlugin` and their conformance suite.
- **The wire** (`services/transport-service/src/wire.ts`,
  `packages/transport/src/fold.ts` delta semantics) is unchanged; only
  `sameConversation` is added.
- **The client boundary** (`packages/transport-client`, `apps/web`) is
  untouched.
- **`TranscriptMirror`**, `decideHistorySync`, `parseHistoryRows`, the
  openclaw/ dsh `mapping` modules, `commands.ts`, and the bindings all stay.

---

## 5. Deliberate behaviour changes

1. **One `running` status per batch.** A batch of user commands now emits a
   single `session-status: running` instead of one per send. Covered by a
   run-loop regression test in `session-runtime.test.ts`.
2. **The equality rule splits into two views.** `sameMessages` (wire) keeps
   comparing ids + role + all parts; `sameConversation` (history convergence)
   ignores ids and neutralizes `file`/`artifact`. This is a latent-bug fix
   (`messageSignature` ignored `role`), but S2's `history-sync.test.ts` cases
   must pin the new semantics rather than assume byte-identical convergence.
3. **openclaw persistence timing** is preserved via `awaitSettle: false`; only
   the notify coalescing path moves.

---

## 6. Judgement calls to confirm before S4

1. **The lifecycle conformance suite does not assert "one in-flight run per
   Session."** openclaw has no adapter-level busy lock (the service answers 409)
   and dsh's `attachFlow` currently overwrites, so asserting it would be a
   behaviour change. `testAdapterLifecycle` asserts only what both adapters
   already satisfy. Turning the busy lock into a seam guarantee is a separate,
   deliberate change (to be aligned with the service's 409 semantics).
2. **`sameConversation` neutralizes `file`/`artifact` on purpose.** The gateway
   history cannot see a client file chip; comparing it would rebuild the
   transcript on every probe. If the intent is instead "compare all part kinds",
   change it in S1 — otherwise S2's new cases pin the neutral projection.

---

## 7. Doc follow-ups (reconcile when the code lands)

- `docs/design/research-agent-framework.md` lists `Transcript`/`RunFlow` as
  "must not change" (§2 table); reword it to point at `SessionRuntime`.
- Any other `docs/` reference to the old kit shape — grep `Transcript`,
  `RunFlow`, `messageSignature` before closing S4.
