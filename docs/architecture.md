# Science Studio — System Architecture

A research-agent platform for computational life-science R&D. Researchers and
managers run and observe agent-driven work with full traceability: every agent
action lands as a reproducible, attributable research record.

This document captures the agreed framework. The domain vocabulary lives in
`/CONTEXT.md`; hard-to-reverse decisions live in `/docs/adr/`.

## 1. Positioning

- **Integrated platform (C)**: agent execution + a research-record layer. The
  management layer is thin; the agent layer is thick. Science Studio's
  differentiator is *experiments reproducible, conclusions auditable*.
- **Domain (X)**: computational / in-silico work first — analysis, modeling,
  literature, hypothesis generation. Wet-lab / instrument integration is
  deferred. Managerial governance is a thin cross-cutting layer.
- **Interaction**: conversation-first. Every Researcher turn is captured as a
  `Run` and persisted by a Science Studio-owned record layer.
- **Units**: `Run` (one Agent execution) is the atomic traceable unit. `Study`
  aggregates `Run`s; `Artifact`s are produced by `Run`s; `Conclusion`s cite `Run`s.

## 2. Monorepo layout

```
science-studio/                         # npm-workspaces TypeScript monorepo
├── apps/
│   └── web/                            # Next.js frontend
│       ├── app/page.tsx                # renders the registered assistant-ui Thread + history sync
│       ├── components/assistant-ui/    # Thread elements from the assistant-ui registry
│       ├── components/ui/              # shadcn/ui base components
│       ├── hooks/ + lib/               # registry helpers, transport hook, session probe
│       └── (Tailwind v4 + shadcn/ui styling stack)
├── packages/
│   ├── transport/                      # assistant-transport seam (runtime-agnostic)
│   │   └── src/types.ts                #   RuntimeAdapter, SessionState/Message, StateDelta
│   ├── transport-openclaw/             # openclaw runtime adapter (port of openclaw-adapter)
│   ├── record/                         # domain + record layer (Run is the atomic unit)
│   │   └── Project/Study/Task/Run/Artifact/Evidence/Conclusion
│   └── (future: transport-codex, …)    # further runtimes behind the same seam
├── services/
│   └── transport-service/              # backend transport service (frontend → uniform protocol)
├── scripts/                            # dev smoke tools (adapter smoke test, SSE replay)
├── docs/                               # architecture + ADRs
└── CONTEXT.md / AGENTS.md              # domain glossary / agent operational notes
```

## 3. Data flow

```
① Conversation path (UI)
   frontend assistant-ui Thread
     useAssistantTransportRuntime({ api: "/api/transport", converter })
     │ POST { commands: [add-message, ...], threadId }
     ▼
  assistant-transport service  (implements the assistant-ui transport protocol)
     │ stream state snapshots (SSE "assistant-transport" or "data-stream")
     │ → frontend converter → assistant-ui messages
     ▼
  RuntimeAdapter.openclaw  ──► openclaw gateway

② Record path (traceability)
   every turn = one Run, authored by the transport-service
     └─► record-service: Project/Study/Task/Run/Artifact/Evidence/Conclusion
```

## 4. The transport seam (assistant-ui assistant-transport)

We adopt assistant-ui's **`useAssistantTransportRuntime`** as the uniform
frontend transport. It is a command-in / state-snapshot-out protocol, so the
frontend is a stateless view over a backend-owned agent state and never changes
when the runtime swaps.

- **Frontend**: `useAssistantTransportRuntime({ api, initialState, converter })`.
  It POSTs `commands` (add-message, add-tool-result, plus custom ones) to the
  backend and consumes streamed state snapshots. `converter` maps the Science
  Studio session state to assistant-ui messages (text / reasoning / tool-call /
  artifact cards).
- **Backend transport-service**: implements the wire protocol (`data-stream`
  default, or `assistant-transport` SSE with `data: … [DONE]`). It delegates to an
  adapter to drive the concrete runtime.

### RuntimeAdapter

`RuntimeAdapter` is the runtime-agnostic boundary. It consumes a normalized
`SessionState` and a batch of `TransportCommand`s and drives the concrete agent
runtime, yielding `StateDelta`s that the transport-service folds into client-
safe state operations:

```ts
interface RuntimeAdapter {
  runtime: string;                                  // e.g. "openclaw"
  init(opts: RuntimeInitOptions): Promise<void>;    // called once on registration
  run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta>;
  abort(reason?: string): void;
  approve(approvalId: string, decision: "approve" | "reject"): void;
  listCommands?(): Promise<CommandDescriptor[]>;    // slash-menu catalog (ADR 0003)
  onArtifact?(artifact: ArtifactInput): void;       // reserved seam; wired later
}
```

- **Reconcile-first.** Every `run()` starts by yielding a `reconcile` delta that
  carries the adapter's canonical transcript. The transport-service compares it
  against the state the client claimed in the request body (`state`) and, when
  they differ, streams a whole-message-map `set` snapshot — so a fresh page load
  or a reload always converges to the full history (no per-request history
  fetch needed on the client beyond a mount-time probe).
- **Client-safe ops.** The assistant-ui client accumulator accepts only `set`
  (and `append-text`) operations, so the transport-service materializes purely
  incremental deltas (`add-part`, `append-text`) into full `parts` `set` ops and
  never emits raw `append`. The openclaw adapter maps gateway chat/agent events
  (or `chat.history` when a transcript is first created) into `StateDelta`s,
  ported from `openclaw-adapter` and run server-side rather than in the browser.
- Future adapters (e.g. codex) implement the same interface against their own
  protocol.

### Runtime commands (slash commands)

Runtime commands (openclaw slash commands today) are **plain "/"-prefixed user
messages** end-to-end — there is no dedicated wire command type (docs/adr/0003).
The gateway interprets a standalone `/command` message itself; the transcript,
reconcile and watch paths treat command rows exactly like any other rows.

- **Command ≠ Run.** A command message is never persisted as a `Run`: the
  openclaw adapter tracks runIds driven by `/`-prefixed sends, and remote
  settles are persisted only after the `chat.history` sync (whose transcript
  guard skips settles whose immediately preceding user row starts with `/`), so
  a remote command turn never becomes a research `Run`.
- **Catalog.** `RuntimeAdapter.listCommands()` returns runtime-agnostic
  `CommandDescriptor`s (`{ id, label, description, icon?, category?,
  invocationText }`). The openclaw adapter proxies the gateway's `commands.list`
  (60s cached) and curates it: a native-text, no-required-argument allowlist
  (session controls + discovery), so availability is still gated by what the
  gateway reports. The transport-service exposes it at
  `GET /api/transport/commands` (JSON); the web route handler proxies it.
- **Frontend.** `useRuntimeCommands` (transport-client) fetches the catalog on
  mount (parallel to the history probe) through the `TransportApiProvider`
  context. The composer (`elements/composer.aui.tsx`) wraps the registry
  composer in `Unstable_TriggerPopoverRoot` and opens a "/" menu only while a
  non-empty catalog is loaded and the thread is idle; picking a command appends
  its invocation text as a normal user message (`aui.thread.append`), leaving
  any partial draft untouched. Hand-typed `/commands` behave identically.

## 5. Record layer

Science Studio owns the research record; it is the source of truth, not any
runtime. `Run` is captured per turn: input message, Agent identity, parameters,
tool calls, outputs. `Artifact` capture is a **reserved interface** now and wired
up in a later iteration.

**The streamed transport state is Science Studio's own normalized Session/Run
state**, not a runtime transcript. The frontend `converter` reads that normalized
state; runtime adapters translate runtime events (e.g. openclaw chat/agent frames)
into updates to it. This keeps the converter runtime-agnostic and the record
authoritative.

## 6. Version 1 scope

- Conversation-first: a Researcher chats with a configured Agent in a `Session`
  under a `Study`; each turn produces a `Run` in the record layer.
- Backend transport service with an openclaw adapter.
- `Artifact` interface reserved, not wired.
- `Workflow` (DAG) orchestration is a later overlay, not in v1.

## 7. Open questions (non-blocking)

- Persistence details for the record layer (Postgres schema, artifact storage backend).
- Auth model for Managers vs Researchers (scopes, device pairing).
- Uniform transport protocol details (SSE vs WS; streaming frame shape).
