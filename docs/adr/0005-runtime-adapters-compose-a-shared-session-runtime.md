# Runtime adapters compose a shared `SessionRuntime`

The two shipped runtime adapters (`transport-openclaw`, `transport-dsh`) each
re-implemented the same per-Session run lifecycle around a shared `Transcript`
base class. We move that lifecycle into one deep module — `SessionRuntime` in
the KIT tier of `@science-studio/transport` — and have each adapter **compose**
it behind a `SessionBehavior` object instead of subclassing `Transcript`. The
public `RuntimeAdapter` seam, its `RuntimeFactory`/`RuntimePlugin` registration,
and the shared conformance suites are unchanged: an adapter delegates
`run`/`subscribe`/`abort` to per-Session `SessionRuntime` instances and keeps
only its event→delta mapping, its launch surface, and the policy hooks its
runtime genuinely needs.

**What the kit owns.** The run-loop skeleton (reconcile-first, probe
termination, user-row echo, flow attach/drain, settle awaited per policy); the
settle pipeline (project → `RecordStoreLike.addRun` → optional durability hook →
watched notify) with the invariant that no persist or hook failure escapes into
the run stream; the watch registry (baseline on attach, one sink set per
Session, coalescing window, teardown); the Run projection skeleton; the
tool-part merge invariant (one `tool-call` part per id, result merged never
appended); and the transcript-equality rule.

**What each adapter keeps.** `apply(event) → deltas` (there is no shared event
vocabulary), `dispatch` (the runtime's launch surface: openclaw `chat.send`,
dsh `runTurn` including its create-only retry), and the hooks justified by a
real variation: `prepare` (openclaw `chat.history` convergence; dsh cold-start
mirror restore), `beforePersist` (dsh mirror save), `projectRun` (openclaw's
command guard + always-`completed` Run; dsh's `turn/end` reason→status plus
token usage and baseline-sliced output), `watch` (250 ms coalescing vs
immediate; async cold baseline from the mirror), and `awaitSettle` (openclaw's
fire-and-forget persistence).

**Why.** Two adapters are what make the seam real: only behaviour they both
duplicated is absorbed. The duplication had already drifted — the kit's
`sameMessages` and openclaw's `messageSignature` answered "are two transcripts
converged?" differently (`messageSignature` ignored `role` and had no `file`
case) — which is exactly the class of bug one shared rule prevents. Composition
(rather than extending the base class) keeps the adapter's surface a plain
function plus data, so a minimal adapter is just `apply` + `dispatch`; the kit
has no runtime-specific branching and is tested with an injected fake behaviour
and scheduler.

**Explicit no-s.** No policy soup: a hook is admitted only when both shipped
adapters (or a concrete third runtime) differ across it. No new ports at the
module's interface: the runtime's event source is adapter-owned and enters the
kit as values (`ingest`) and callbacks, because a shared event-source port would
have a single implementation per runtime and no shared shape. `contract-tests`
stays `./seams`-only — `SessionRuntime`/`SessionBehavior` are kit, not seam — so
the shared lifecycle conformance suite drives the `RuntimeAdapter` contract with
an adapter-supplied scripted driver rather than importing the kit class.

- **Status**: accepted
- **Considered options**:
  - *Extend the `Transcript` base class* — smaller diff and the current test
    style constructs transcript subclasses directly, but it turns the extension
    point into co-varying protected methods (openclaw's adapter had grown to a
    700-line module) and re-creates the policy soup in the base class. Rejected
    in favour of composition.
  - *Ports & adapters for the event source, notify clock, and canonical I/O* —
    makes the seams explicit, but three of the four would be single-production-
    adapter indirection at the kit's interface. Rejected; only an injectable
    scheduler is kept, so coalescing is deterministic in tests.
  - *One overloaded `apply(input)` carrying both runtime events and lifecycle
    phases* — fewest entry points, but every adapter must discriminate the
    lifecycle case before its own event switch and the launch surface mixes into
    the event mapper. Rejected.
- **Consequences**: `Transcript` is retired (it had no caller outside the kit);
  `RunFlow` stays a public kit primitive — the service's wire regression test
  replays the fold-and-fan-out pipeline with it — but loses its
  `targetRunId` field. `Turn`, `SessionTranscript`, `DshTranscript` and
  `messageSignature` are retired; `runOutput` becomes the kit's `textOutput`,
  while the dsh-specific `runStatus` stays in its package. The one deliberate
  behaviour change is that a batch of user commands emits a single `running`
  status instead of one per send.
