# Subagent activity is an optional adapter surface, live-only

The Subagents panel shows a runtime's LIVE delegated-agent runs through one new
OPTIONAL seam member, `RuntimeAdapter.subagents?(sessionKey)`, and a normalized
`SubagentRun` view. The dsh adapter assembles the list in memory from the
harness child's own notifications and never persists it; the service reads it
over `GET /api/transport/subagents`.

- **Status**: accepted
- **Context**: the pinned dsh SDK protocol already emits `subagent.started` and
  `subagent.finished`, and a child session's log carries a
  `subagent/descriptor`; every one was discarded at the adapter boundary, so
  the Subagents module had no data source. The record vocabulary for v1 is
  Project/Session/Run (docs/adr/0007) and has no place for a delegated run; a
  persist-first design would have to invent a record entity whose only reader is
  this panel. Meanwhile the transport kit's watch is a per-session transcript
  channel and does not own (or know about) adapter-global subagent state.
  *Considered and rejected*: extending `WatchSnapshot`/`StateDelta` with a
  subagent member. It would couple the shared kit and the watch protocol to a
  concept the kit does not own and force every watch consumer to understand it.
- **Decisions**:
  - **An optional method, not a new channel.** `subagents?` joins
    `listCommands?`/`subscribe?`/`approve?` as a capability the service branches
    on via `capabilities.subagents`. A runtime without it answers an empty list,
    so the route and panel stay runtime-agnostic.
  - **Live-only, in memory.** The adapter's registry is dropped with the child
    generation. No record field, no disk mirror. A restart empties the panel by
    design; the wire carries no timestamps, so the adapter stamps them.
  - **A child-wide standing subscription.** `HarnessClient.subscribe()` is
    attached once after `start()`, NOT per run: a background/continuable
    subagent can outlive the parent turn, and the per-run `session.run` channel
    closes at root idle. That is what keeps a long-lived child's status live.
  - **Structural payloads, fail soft.** The registry reads notification shapes
    structurally and never throws into the run stream (the child bridge plugin's
    rule), so a harness pin that moves a shape degrades to an unlabeled entry.
  - **Remote subagents are out of scope.** The harness only announces
    `subagent.finished` for LOCAL (in-process) children, so ACP/remote runs
    never appear. Recorded as a known limitation, not a bug.
- **Consequences**: the panel gains a live view without touching the record or
  the transcript watch. The list disappears on restart; a subagent whose
  `finished` never arrives reads `running` until the child goes away. If
  persistence or transcript drill-in is ever needed, a new record entity and a
  child-transcript capture path are the work — this decision should be revisited
  then.

## Addendum (2026-09-18)

The **dsh-specific durability decision** is re-scoped: "live-only, in memory"
held when the panel needed *a* data source; in practice the only useful
moment to read it is *after the fact*, usually after a restart. The dsh
adapter now keeps a durable per-Session subagent ledger — one JSON file per
session key under its transcript dir (the `TranscriptMirror` placement
pattern), restored on every adapter generation, with a restored `running`
entry settled to `aborted` (its child died with the previous process). What
is UNCHANGED: the surface stays the optional `subagents?`/`subagentTranscript?`
adapter methods; nothing enters the record (v1's `Project`/`Session`/`Run`
vocabulary is untouched); other runtimes may stay live-only (openclaw does).

The same addendum introduces a drill-in: a delegated session's readable
record is served by the *owning* runtime — dsh reads the harness's own
durable child-session log (zstd JSONL, decoded with Node's built-in `zlib`),
exposed as `GET /api/transport/subagents/:childId/transcript` under the
existing Project scope claim — and the workbench opens it as a synthetic
tab. The read is fail-soft: absent/mismatched/unreadable logs answer `null`
(404 / a friendly state), never an error.
