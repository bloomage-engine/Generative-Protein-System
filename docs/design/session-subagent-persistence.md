# Durable Session & Subagent Transcript

Status: design (v1 = restart-survival). Audience: maintainers of
`packages/record`, `packages/transport`, `packages/transport-dsh`,
`services/transport-service`, `packages/contract-tests`. Decision record:
[`docs/adr/0019`](../adr/0019-durable-session-and-subagent-transcript-belongs-to-the-record.md).
Vocabulary: `Transcript`, `Subagent` (added to `/CONTEXT.md`).

This plan makes the record the single durable source of truth for a settled
session's full transcript and for every subagent (its run and its captured
transcript), keyed by a stable id. Reference model: dsh's `SessionPersistence`
— which this design adopts for **ownership** (durable truth keyed by a stable
id, subagents as lineage-bearing sessions) but NOT for **mechanism** (no
append-only event log, single-writer, flush, or mid-turn crash recovery — that
is the deferred "full dsh model").

---

## 1. Problem, in one line

The thin store (record) is authoritative; the rich one (the adapter's mirror)
is the restore source. On a restart the rich one is gone and the thin one
can't rebuild it. Invert the ownership so the record holds the rich content,
and give every subagent a stable id + a durable parent link + its own captured
transcript.

Scope bar (locked):
- **IN**: a settled session's full transcript + its subagent runs/transcripts
  survive a service restart, in the record's custody, keyed by stable ids.
- **OUT**: mid-turn crash-resume, append-only event log, single-writer, flush.

---

## 2. Data model (the two new durable objects)

`Run` is **unchanged** (stays the rollup). `Transcript` and `Subagent` are the
new durable source of truth. `SessionState`/`Message` are the runtime's
vocabulary (`@science-studio/transport/seams`); the record stores them as an
**opaque JSON payload** it does not interpret (see §3).

```ts
// the runtime's canonical transcript, stored opaquely by the record
interface PersistedTranscript {
  v: 1;
  status: string;                       // "idle" | "running" | "error"
  messages: unknown;                    // the runtime's full Message[] (JSON); the record does not read it
}

// a durable, stably-identified subagent: a lineage-bearing session
interface Subagent {
  id: Id;                               // stable, adapter-minted ("subagent-<uuid>")
  parentSessionId: Id;                  // the parent Science Studio Session (stable record Session id)
  origin: "subagent";
  label?: string;
  provider?: string;
  status: "running" | "completed" | "aborted" | "error";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  transcript?: PersistedTranscript;     // the child's own conversation, captured on settle
}
```

`Run` is unchanged in v1: the adapter still computes it (`projectRun`) and it
stays the record's rollup projection. It coexists with the Transcript under the
record's custody — the Transcript is the authoritative conversation, the `Run`
is the rollup. (Deriving `Run.input`/`output` from the Transcript, so there is
one source, is future polish, not v1.)

---

## 3. Record seam + physical layout

`packages/record` must stay a **leaf**: `packages/transport` already depends on
it for `Id`/`Run`/`RunStatus`, so the record **cannot** import a typed
`Message[]` (dependency cycle). It therefore persists the transcript as an
opaque JSON payload: shape is owned by the runtime, the record only stores and
returns it.

New `RecordStore` members (and the adapter-facing `RecordStoreLike` re-exports
them with typed `Message[]`):

```ts
saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void>;
loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null>;
upsertSubagent(subagent: Subagent): Promise<void>;
loadSubagent(id: Id): Promise<Subagent | null>;
listSubagents(parentSessionId: Id): Promise<Subagent[]>;
```

Physical layout — a sibling of `record.jsonl`, derived from it, **no new env var**:

```
$RECORD_STORE_PATH   (default ~/.local/share/science-studio/record.jsonl)
dirname → ~/.local/share/science-studio/
  record.jsonl                    # thin rollup (Project/Session/Run) — unchanged
  transcripts/<sessionId>.json    # PersistedTranscript — atomic rename, one file per session
  subagents/<stableId>.json       # Subagent (row + self-contained transcript) — one file each
```

The `TranscriptMirror` codec (v/sessionId/status/messages + temp-then-rename)
moves into `packages/record`; the dsh adapter's `mirror.ts` is removed. The
in-memory store keeps the same two objects in `Map`s. Both impls pass a new
contract-tests suite.

---

## 4. dsh adapter changes (mirror → record)

- `behavior.ts` `prepare()`: `mirror.load(sessionKey)` →
  `recordStore.loadSessionTranscript(sessionKey)`. The "never reconcile an
  unverifiable empty transcript against a claiming client" rule
  (docs/adr/0004) is **unchanged** — a `null` load is handled exactly as the
  mirror's `null` is today.
- settle pipeline (`SessionRuntime`): `mirror.save(...)` →
  `recordStore.saveSessionTranscript(sessionId, { v:1, status, messages })` —
  same point in the settle pipeline, same payload, new home.
- `mirror.ts`: **delete**. If a write-behind buffer is wanted, it is an
  in-memory staging in front of the record call, not a separate store.
- `subagents.ts` / `ledger.ts`: `SubagentRegistry` persistence moves from the
  file ledger to `upsertSubagent`/`listSubagents`; `list()` merges in-flight
  live rows with the record's durable ones.

---

## 5. Subagent identity

- The adapter mints a **stable id** (`subagent-${randomUUID()}`) at
  subagent-start and persists it as the durable key; it keeps a
  `stableId → harnessChildId` map **only** to fetch the live child's
  transcript on settle.
- **Capture on settle**: instead of reading the harness's zstd child log at
  drill-in (docs/adr/0018), the child's transcript is fetched and written into
  the record (`upsertSubagent` with `transcript`). After a restart,
  `loadSubagent(id).transcript` is directly readable — no harness id, no
  harness home.
- Panel + drill-in routes: `/api/transport/subagents` and
  `/api/transport/subagents/:childId/transcript` take a **stable id** (not a
  harness id) and read the **record**. Lineage (`parentSessionId`, and later `depth`)
  is durable and traversable across restart.
- docs/adr/0016 addendum updated: the "durable ledger" now lives in the
  record's custody. openclaw (and any other runtime) may stay live-only —
  nothing is forced onto runtimes without a durable transcript source.

---

## 6. Durability & invariants (v1)

- Durability barrier = the record store's **atomic rename** per write (a
  resolved write is on disk). The settle pipeline still contains every failure
  and never lets one escape the run stream.
- Preserved invariants: empty transcript never overrides a claiming client;
  a restored `running` subagent settles to `aborted`; structural subagent
  payloads never throw into the run stream.
- Not introduced (deferred "full dsh model"): append-only event log,
  single-writer handle, `flush` barrier, `interruptedTurnClosers`. The
  `transcripts/<id>.json` file is the growth point — one file can later become
  an append-only log without a shape change to the key.

---

## 7. Migration & testing

- **Migration** (one-time, single-user): for each record Session with no
  `transcripts/<id>.json`, copy it from the old `DSH_TRANSCRIPT_DIR`/`/tmp`
  if present; otherwise reconstruct from the record's `Run` rows (the same
  `input`→user / `output`→assistant fold already used to recover the 软骨素
  session). Optional: run once automatically on first service start.
- **contract-tests**: a transcript + subagent conformance suite (round-trip,
  stable keys, atomicity, `listSubagents` parent scoping) that both the
  in-memory and JSONL `RecordStore` impls run.
- **dsh behavior tests**: a **restart regression** — settle a turn (gen 1),
  tear the adapter down, bring up gen 2, assert `loadSessionTranscript`
  returns the full transcript. This is the direct regression for 软骨素.
- **web e2e** (optional): open a session after a service restart; the
  conversation is present.
- **Docs**: ADR 0019 (this); CONTEXT.md gains `Transcript` + `Subagent`; ADR
  0016 addendum points the durable ledger at the record.

```
Slices (A=add, M=modify, D=delete) — each independently releasable:
|       | File                                                        | Change |
| A     | packages/record/src/types.ts, index.ts, {memory,jsonl}.ts   | Transcript + Subagent, new seam methods + layouts, contract |
| A     | packages/contract-tests/src/...                             | transcript/subagent conformance suite |
| M     | packages/transport/src/types.ts (RecordStoreLike)           | re-export the 5 methods, typed Message[] |
| M     | packages/transport-dsh/src/{behavior,adapter}.ts            | prepare→record, settle→record, subagent capture→record |
| D     | packages/transport-dsh/src/{mirror,ledger}.ts               | codec moved to record; registry→record |
| M     | services/transport-service/src/{project-scope,subagents}.ts | subagent routes read record (stable ids) |
| M     | docs/adr/0016-*.md (addendum), CONTEXT.md                   | durable-ledger home; glossary |
```
