# dsh live assistant streaming rides a child plugin over the bridge socket

The dsh adapter streams assistant output at **step granularity** today: the SDK
wire pushes one committed `session.event` per log event, and the step's whole
`assistant/message` (reasoning, text, tool calls) is committed only after the
model stream for that step has finished. The user therefore sees a long silence
followed by one burst, and thinking / tool calls "pop in" complete. This ADR
adds a **live** path on top: the harness child's process-local
`agent/assistant-stream` frames are forwarded to the adapter, which maps them to
the existing `StateDelta` vocabulary while the step is still streaming. The
durable event remains the authoritative settlement.

- **Status**: accepted
- **Context**: On the SDK protocol the only notifications are `session.event`,
  `session.status`, `subagent.started` and `subagent.finished`
  (`@deepseek-ai/dsh-sdk-protocol`), and `session.event` is emitted when an event
  is **committed** to the session log. An `assistant/message` is appended once,
  at the end of the step, carrying the whole message plus its compact
  `stream: AssistantStreamRecord[]`. Token deltas never travel on the wire. Inside
  the child, however, the agent loop publishes a process-local
  `agent/assistant-stream` event (`start` / `chunk` / `end`) for every emitted
  `StreamChunk` (`text-delta`, `reasoning-delta`, `tool-call-delta`, block and
  finish chunks) — the same source the harness's own web client folds for live
  rendering (`dsh-api-session-controller`). The dsh adapter already ships
  dependency-free child plugins over a private per-launch patch and UNIX socket
  (docs/adr/0011, 0012, 0017, 0020); that socket is the transport this decision
  reuses. A partially written handler in `transport-dsh/src/behavior.ts` (reading
  `data.stream` and emitting `stream-text`) neither produced live output — every
  op is still emitted in one synchronous `apply` — nor preserved the step's
  reasoning / tool-call parts when the stream held text, and the behavior tests
  never exercised it because their fixtures carried no `stream` field.

- **Decisions**:
  - **Live tokens come from the child, over the existing bridge socket.** The
    child-side `bridge-plugin.ts` gains a host-scope
    `ctx.on("agent/assistant-stream", …, { global: true })` listener and a
    streaming `GET /assistant-stream` route that writes `{ sessionId, frame }`
    as NDJSON, registering the listener when a client connects and disposing it
    on disconnect. No new socket and no new launch patch: the plugin is already
    injected, and the socket is already process-private and owner-only. The
    plugin stays dependency-free and never writes stdout.
  - **The adapter subscribes once per child generation.** `DshCommandBridge`
    (in `bridge.ts`) gains an optional `subscribeAssistantStream?(listener)`; the
    adapter attaches it in `ensureStarted()` beside `attachSubagents()`, so it is
    re-established after a child restart. A missing bridge or a dead stream
    **degrades silently** to the step-granular mapping — live streaming is an
    optimization, never a requirement.
  - **Frames are routed to the active Run and emitted as deltas.** The behavior
    gains an out-of-band `ingestAssistantStream` entry: it resolves the plugin
    envelope's harness `sessionId` to the Science Studio session key, finds that
    session's in-flight `RunControl` (registered by `dispatch` for the life of
    the turn), and calls `run.emit(delta)` (which folds into the canonical
    transcript *and* fans out to the client flow). Subagent sessions are filtered
    out by the same harness-id lookup.
  - **The live assistant row is keyed deterministically by
    `sessionId:turn:step`, and the durable settlement keeps that id.** The plugin
    envelope carries the harness `sessionId` and the `start` frame carries
    `turn`/`step`, so the row id is known before any content. A retried attempt
    resets the *same* row (its `start` clears the parts), so a failed/retried
    attempt leaves no orphan and **no `remove-message` delta is needed**. When
    the durable `assistant/message` arrives for that step, the behavior finalizes
    the live row with the authoritative `contentToParts(...)` content and **keeps
    the row id** — the client never swaps keys mid-stream; frames arriving after
    a step is finalized are ignored. When no live row exists (bridge
    unavailable, stream lagging behind the durable event, or a non-streaming
    build) the handler falls back to today's durable-id path unchanged.
  - **One seam op is added: `stream-reasoning`.** It appends to the trailing
    `reasoning` part (or starts one), folding to the existing `text-appended`
    effect, so the service wire and the client accumulator need no change. This
    is preferred over a cumulative `set-part-text` stream, which is O(n²) in the
    reasoning length. A `remove-message` op is deliberately **not** added:
    deterministic ids plus reset-on-attempt cover the lifecycle.
  - **The step's mapping drops nothing.** `contentToParts` remains the single
    authoritative block→part mapping; the live path only decides *when* parts
    appear, never whether reasoning / tool calls exist. The committed event
    overwrites the row with the full part list, so a live-assembly drift cannot
    persist.

- **Consequences**:
  - Thinking and text render progressively from the first generated token; a
    tool call appears at its first delta, its args grow with later deltas, and
    the assembled block finalizes it. The durable record and the settled `Run`
    projection are unchanged.
  - Touches: `packages/transport-dsh` (`bridge-plugin.ts`, `bridge.ts`,
    `client.ts`, `behavior.ts`, tests), `packages/transport`
    (`types.ts`/`fold.ts`/`fold.test.ts` for `stream-reasoning`). No change to
    `services/transport-service` (its `WireOpsBuilder` already formats the
    reused effect), the record, the workspace, or `molql`.
  - A step whose attempts all fail commits only `assistant/attempt` (no
    message). Its live row is left as-is — the partial output the model produced
    before the failure stays visible — which is a deliberate, visible change
    from today's "nothing for a failed step", and is consistent with failed
    turns being recorded (docs/adr/0004).
  - The live frames are **transient and non-durable** by construction: a service
    restart mid-step loses them, and cold restore still reads the record's saved
    transcript (docs/adr/0019). This is intentional — the harness log is not
    replayable on the SDK wire (docs/adr/0004).
  - The bridge socket now carries one persistent NDJSON stream per child, in
    addition to its request/response verbs; it remains process-private and
    torn down with the child generation.
