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

## Amendment (2026-09-09): SDK sessions are create-only across processes

The original assumption that the same harness session id survives a harness
child restart is FALSE for this SDK: `dsh-sdk-jsonrpc-server`'s
`session/prompt` is create-only (`getOrCreateSession` → `agents.create`; no
resume/adopt path on the SDK wire), and a NEW child cannot create an id a
PREVIOUS process already materialized under the harness home — it answers
`session "<id>" already exists` (code `-32603`). A Science Studio session
still maps to one dsh session per child generation, but after a service
restart the adapter retries the turn ONCE on a fresh child-scoped id
(`<sessionKey>-<ts>-<rand>`) instead of settling the run to error: the run
always completes, the transcript mirror (the UI truth, keyed by the Science
Studio session) is unaffected, and the agent loses only its pre-restart
conversation memory. The service also funnels assistant-ui's per-page
`__LOCALID_*` thread ids (and absent ids) to the runtime's default session so
the mount probe and sends converge on one canonical transcript.

- **Superseded in part** by the 2026-09-14 amendment below: ids are now minted
  inside the child's own generation, so the restart collision is designed away
  rather than recovered from (the retry survives only as a net).

## Amendment (2026-09-14): harness ids are scoped to the child generation

Retrying on the collision made the FIRST turn of every restart pay for it: the
adapter asked for the bare session key, the durable home rejected it, one
error (with a JSON-RPC stack) was logged, and an orphan session was minted —
observable in `<dsh_home>/sessions/<cwd-slug>/` as `default` plus one
`default-<ts>-<rand>` per restart. The create-only constraint is the same, so
the id is now chosen instead of repaired: every harness id is minted inside the
generation of the child that will own it
(`<sessionKey>-<ts>-<rand>`, one generation per adapter init), and turns within
one child reuse that id through the adapter's `harnessSessions` map. The first
prompt of a new child is therefore always creatable — no rejected prompt, no
error log — while a restart still starts a fresh harness session (the SDK
cannot resume the old one either way). Conversation continuity across restarts
remains the adapter's transcript mirror (keyed by the Science Studio session);
the agent's own memory still stops at the restart boundary.

The `already exists` failure is still handled once, now as a net for the only
remaining case — an id another process minted at the same instant. That failure
lands BEFORE any agent work, so re-prompting a fresh id cannot double a reply.

- **Status**: accepted
