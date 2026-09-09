# dsh runtime adapter is a local harness subprocess (cold-start restores its own transcript mirror)

`packages/transport-dsh` implements the `RuntimeAdapter` seam over DeepSeek
Harness (dsh) by depending on the official `@deepseek-ai/dsh-sdk-client`,
pinned exactly (`0.1.5-alpha.1`), which spawns the same-version `dsh --profile
sdk` CLI as a child process speaking newline-delimited JSON-RPC over stdio
(`initialize` / `session/prompt` / `shutdown` requests; `session.event` /
`session.status` notifications). Unlike openclaw — a remote gateway reachable
via `RuntimeConfig { url, token }` — dsh is a **local harness**: the adapter
does not hand-roll the stdio framing (that is the SDK client's job) and does
not force dsh into the url/token config shape. The seam gains an optional
runtime-agnostic `config` bag; the `gateway` field stays openclaw's.

A Science Studio Session maps 1:1 to a Harness Session under the **same id**
(the SDK's `session/prompt` takes a client-chosen id and lazily creates the
agent+session pair). One `run()` = one prompt = one Harness **turn**, persisted
as one `Run` for every terminal `turn/end` reason (completed/error/aborted…),
so failed turns are still recorded — a deliberate deviation from openclaw,
which only persists settled runs. The SDK wire has **no approval or ask-user
surface** (nothing to wire in v1) and **no token stream**: `assistant/message`
events carry a whole step's content blocks, so the adapter emits committed-event
granularity deltas and never fabricates token-level `stream-text`.

The load-bearing wrinkle is **cold-start reconcile**: the SDK exposes no
history-replay request — `session.event` notifications only flow while a client
is live — so a service restart would otherwise leave the adapter with an empty
transcript while the client still claims history. Reconcile-first must never
reconcile an unverifiable empty transcript against a claiming client, which
would wipe that client. Instead of reading dsh's volatile internal session log
(uncompressed JSONL under `<dsh_home>/sessions`; `SESSION_FORMAT_VERSION` bumps
without compatibility promises), the adapter persists **its own transcript
mirror** — one Science Studio-owned JSON file per session under
`DSH_TRANSCRIPT_DIR`, written on every settled run and restored on cold start.
The mirror is safe because dsh SDK sessions have a single writer (this adapter;
no approvals, no remote UI, no history RPC that would let another writer in),
so the folded canonical transcript cannot diverge from the harness truth. The
client-claimed-state fallback is unnecessary: the wire folds every run against
the claimed state, and an adapter that restored its mirror (or a truly fresh
session) always has a verifiable canonical to reconcile with.

- **Status**: accepted
