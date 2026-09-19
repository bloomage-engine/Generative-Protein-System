# The durable session transcript and every subagent belong to the record

- **Status**: accepted (v1 scope = restart-survival; the full dsh crash-resume model is deferred)
- **Context**: Science Studio currently keeps two stores that drift, and the rich
  one is ephemeral. The **record** (`record.jsonl`, the authoritative store per
  docs/adr/0002) is durable but **lossy** — a `Run` carries only `input` +
  `output` strings. The **transcript mirror** (`DSH_TRANSCRIPT_DIR`, default
  `/tmp`) is the **rich** full message view but is **ephemeral +
  adapter-owned**, and is the *de-facto* restore source even though its own
  comment says it "is never the source of truth" — so a service restart drops
  the whole conversation (reproduced: a session with 26 record `Run` rows whose
  mirror held only 2 messages). The **subagent** ledger (docs/adr/0016 addendum)
  is durable but keyed by **per-generation harness ids**, so a child's identity
  and transcript do not survive a restart. In short: the thin store is
  authoritative; the rich one is the restore source — the two are inverted
  relative to the stated ownership, and both lose the rich content on
  restart.

  The dsh harness's own persistence model (its `SessionPersistence` seam) is the
  reference: a durable log keyed by a **stable** id is the single source of
  truth, and a subagent is a **lineage-bearing session** (`parentSession`,
  `origin:'subagent'`, `delegationDepth`) whose parent link and transcript
  survive restart.
- **Decisions**:
  - **The record owns the durable rich transcript.** A settled session's
    canonical transcript — the full message view with tool calls, reasoning and
    multi-part text — is persisted **in the record's custody**, keyed by the
    **stable record Session id**. The record store's seam gains
    `saveSessionTranscript` / `loadSessionTranscript`. The restore path
    (`prepare` in runtime adapters) reads from the record, not from an
    adapter-owned mirror. This makes the code match docs/adr/0002 ("the record
    is authoritative") instead of bending it.
  - **The record stores the transcript as an opaque JSON payload, not as a
    typed object.** The runtime (adapter) defines the message shape; the record
    persists + returns it without interpreting it. This is what keeps
    `packages/record` a **leaf** (it must not import `packages/transport`,
    which already depends on `packages/record` for `Id`/`Run`/`RunStatus` — a
    typed `Message[]` on the record side would be a dependency cycle).
  - **Every subagent is a durable, stably-identified entity in the record.**
    The adapter mints a **stable id** (e.g. `subagent-<uuid>`) at
    subagent-start and uses it as the durable key from then on; the harness
    child id is demoted to a per-generation detail used only to fetch the live
    child's transcript. The record row carries the stable id, a durable
    `parentSessionId` (the parent's record Session id) — the lineage dsh keeps
    in its `SessionHeader` — `origin: 'subagent'`, the run metadata, and the
    child's **own captured transcript**. The record store's seam gains
    `upsertSubagent` / `loadSubagent` / `listSubagents(parentSessionId)`.
  - **Run is unchanged in v1.** The adapter still computes it (`projectRun`);
    it stays the record's rollup projection. The `Transcript` is a *separate*
    new durable object that holds the full conversation, so both coexist under
    the record's custody — the transcript is the authoritative conversation,
    the `Run` is the rollup. (Deriving `Run.input`/`output` from the
    Transcript is future polish, not v1.)
- **Consequences**:
  - A restart can no longer drop a settled session's conversation or its
    subagents: both live under `RECORD_STORE_PATH`'s directory
    (`transcripts/<sessionId>.json`, `subagents/<id>.json`), service-owned,
    keyed by stable ids.
  - `DSH_TRANSCRIPT_DIR` and the `TranscriptMirror` retire — their job moves
    into the record store; the ephemeral directory is no longer a data sink.
  - The subagent panel and its drill-in read the **record's** durable rows
    (stable ids), so the drill-in transcript no longer depends on the harness
    home or a resolvable harness id.
  - This is the v1 "restart-survival" bar only. It deliberately does NOT adopt
    dsh's append-only event log, single-writer handle, `flush` barrier, or
    mid-turn crash recovery (`interruptedTurnClosers`) — those remain the
    deferred "full dsh model." The physical layout (`transcripts/<id>.json`)
    leaves room to grow one file into an append-only log later.
  - Touches visible seams: the `RecordStore` contract and the
    adapter-facing `RecordStoreLike`, so `packages/contract-tests` gains a
    transcript/subagent conformance suite the in-memory and JSONL impls both
    run (docs/adr/0005's rule: implementers run the same suites).
