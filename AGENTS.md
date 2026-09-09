# AGENTS.md

npm-workspaces TypeScript monorepo. Artifacts (commit messages, README, docs,
ADRs, AGENTS.md, design specs) are written in English; conversation happens in
Chinese.

## Structure

```
apps/web                          Next.js frontend (assistant-ui Thread UI, port 3000)
  app/page.tsx                      renders the registry-registered assistant-ui `Thread`
  components/assistant-ui/elements  Thread UI registered from the assistant-ui registry
  components/ui + hooks + lib       shadcn/ui base, registry helpers
  (Tailwind v4 + shadcn/ui styling stack: postcss.config.mjs, components.json)
packages/record                   domain + record layer (Run is the atomic unit)
packages/transport                runtime-agnostic seam (RuntimeAdapter, StateDelta)
packages/transport-client         assistant-ui client boundary (`useTransport` hook, standing `useTransportWatch`, state converter, mount probe, command catalog)
packages/transport-openclaw       openclaw runtime adapter (backend operator client; ports gateway WS)
packages/transport-dsh            dsh runtime adapter (local harness child spawned by @deepseek-ai/dsh-sdk-client, pinned 0.1.5-alpha.1; stdio JSON-RPC)
services/transport-service        backend assistant-transport service (SSE endpoint, port 3001; TRANSPORT_RUNTIME=openclaw|dsh picks the default adapter)
examples/transport-openclaw-example  minimal assistant-ui example app over the openclaw adapter (Vite + core primitives; dev-only, not in the root build)
examples/transport-dsh-example     minimal assistant-ui example app over the dsh adapter (local harness; dev-only, not in the root build)
scripts/                          dev smoke tools (smoke-openclaw-adapter, replay-sse-frames)
docs/architecture.md              system architecture
docs/adr/                         ADRs (0001 backend transport, 0002 record ownership)
CONTEXT.md                        domain glossary (authoritative vocabulary)
```

## Commands

- `npm install` — install all workspaces
- `npm run dev` — run service (3001) and web (3000) together via concurrently
- `npm run dev:service` / `npm run dev:web` — individually
- `npm run dev -w @science-studio/transport-openclaw-example` — the example app: Vite (5173, proxies `/api`) + the openclaw adapter behind `@science-studio/transport-service` (3200). Needs `examples/transport-openclaw-example/.env` (see its `.env.example`) and a live gateway, and `npm run build` first (imports deps from dist). Dev-only — intentionally NOT in the root build gate; its `npm run test` drives the same wiring against a scripted gateway (no live gateway needed).
- `npm run dev -w @science-studio/transport-dsh-example` — the same shape over the dsh adapter: Vite (5173) + `@science-studio/transport-service` (3300); the adapter spawns `dsh --profile sdk` locally (needs `examples/transport-dsh-example/.env` with `DEEPSEEK_API_KEY` only — the harness child runs with that folder as cwd, so the dsh CLI reads that same `.env` and hard-refuses launch-only `DSH_*` keys there; defaults: profile `sdk`, home `~/.dsh`, workspace = the example dir, transcript mirror under the service tmp dir — override `DSH_HOME`/`DSH_TRANSCRIPT_DIR`/`DSH_MODEL`… via exported env). Its `npm run test` drives the wiring against a scripted turn client (no dsh process needed).
- `npm run build` — build record → transport → transport-client → transport-openclaw → transport-dsh → transport-service; this is the real type gate
- `npm run typecheck` — **known-broken**: fails in transport-service with pre-existing TS6310 (composite refs + `--noEmit`). Other workspaces pass; use `npm run build` for the service.
- `npm run smoke:adapter` — connect a real openclaw adapter to a live gateway and drive one `chat.send` (sends a real message to `OPENCLAW_DEFAULT_SESSION` unless `SMOKE_SESSION` overrides it). Needs `npm run build` first.
- `npm run smoke:replay -- <file>` — fold recorded SSE frames through the client decoder/accumulator (verifies a stream terminates with `[DONE]` and only uses `set` ops).
- No test suite exists anywhere yet (root `npm run test` is a no-op). — **stale**: transport-openclaw, transport-client, transport-dsh and both example workspaces now have suites (root `npm run test` runs them).

## Transport wire contract (frontend ↔ service)

- Frontend is assistant-ui's `useAssistantTransportRuntime`. It sends user
  messages as **`message.parts`** (array of `{type:"text",text}`), NOT
  `message.content`; `normalizeCommands` reads `msg.content ?? msg.parts`.
- SSE frame per op: `data: {"type":"update-state","path":[],"operations":[...]}`.
  The client accumulator (`assistant-stream` GorpStreamAccumulator) accepts
  **only op types `set` and `append-text`** — anything else (e.g. raw `append`)
  throws and kills the whole stream. The transport-service therefore only
  emits **`set`** and **`append-text`** ops: purely incremental adapter deltas
  (`add-part`, `append-text`) are materialized into full `parts` arrays by its
  wire fold (`WireOpsBuilder`), while token fragments (`stream-text`) become
  small `append-text` ops at the exact text path. Array paths are illegal for
  arrays; keys
  `__proto__`/`constructor`/`prototype` are rejected in segments.
- **Reconcile-first.** Every `run()` starts by yielding a `reconcile` delta
  carrying the adapter's canonical transcript. The service compares it with the
  state the client claimed in the request body (`state`) and streams a
  whole-message-map `set` when they differ (and a `status` `set` when the status
  drifted) — so a fresh page or a reload always converges to the full history.
  The adapter re-syncs its canonical transcript against gateway `chat.history`
  at the START of every `run()` (not just the first): the gateway owns the
  conversation and is not the only writer, so turns that arrived remotely
  (e.g. on the openclaw UI — including their USER rows, which never pass
  through this process) are converged by rebuilding the transcript from the
  gateway rows whenever the history is not a content-prefix (role + part
  texts) of the transcript. A gateway session reset therefore also clears the
  stale in-memory transcript, and standalone `toolResult` history rows merge
  into their assistant tool-call part instead of becoming messages. Sync
  never runs mid-run (a rebuild would wipe the partially assembled assistant
  message), and a lagging gateway keeps the local tail — an empty or
  shorter-matching history is not a reset unless the transcript holds ≥ 2
  messages and is not mid-run, so a single never-persisted message (failed
  `chat.send`) survives.
- **History on load is driven by a client probe**, not a library behaviour:
  `apps/web/app/page.tsx` mounts `useTransport` (from
  `@science-studio/transport-client`), which POSTs the empty-command request on
  mount and imports the folded snapshot via
  `runtime.thread.importExternalState`. That probe **must end with `data: [DONE]`**
  (the service always writes it), otherwise the import never settles and the
  composer stays locked. The same is true for any run whose flow never ends —
  `RunFlow` must be ended on a terminal chat event (`apply()` →
  `activeFlow.end()`) and immediately for empty command batches.
- The service fold seeds its mirror from the claimed/`reconcile` state; if a
  client's claimed state already matches the canonical transcript, the probe
  returns only `[DONE]` (no redundant snapshot).
- **Token streaming**: the openclaw adapter maps gateway `chat` `delta` events
  (`ChatDeltaEvent.deltaText`) to `stream-text` deltas that grow the message's
  trailing text part; the wire fold emits a small `append-text` op at the exact
  `messages/<id>/parts/<i>/text` path (never whole-message rewrites per token),
  and `replace:true` deltas become `set`. Tool calls are streamed as
  `agent`/tool events coalesced into ONE `tool-call` part per `toolCallId`
  (start + result merged) in event order; the `final` chat snapshot is only
  used as a fallback when nothing was assembled live.
- **dsh differs from openclaw in three wire-relevant ways**: (1) the dsh
  adapter spawns a LOCAL harness (`dsh --profile sdk` via
  `@deepseek-ai/dsh-sdk-client@0.1.5-alpha.1`, pinned exactly) instead of
  connecting to a gateway; (2) events arrive per COMMITTED log event, not per
  token — each step's `assistant/message` becomes a whole-message `set`, so
  replies render step-granular and the adapter never fabricates
  `stream-text`/`append-text` token fragments; (3) the SDK wire has no
  history-replay request, so the adapter persists its OWN transcript mirror
  (`DSH_TRANSCRIPT_DIR`, default under the service tmp dir) and cold-restores
  from it — an unverifiable empty transcript is never reconciled against a
  claiming client (docs/adr/0004).
- Service-adjacent verification without the browser:
  `curl -sN -X POST http://localhost:3001/api/transport -H 'content-type: application/json' -d '{"commands":[{"type":"add-message","message":{"role":"user","parts":[{"type":"text","text":"hi"}]}}]}'`
  — with a live gateway this streams real frames and must terminate with `[DONE]`.

## Architecture rules

- **Record is authoritative.** Science Studio owns the research record
  (`Project`/`Study`/`Task`/`Run`/`Artifact`/`Evidence`/`Conclusion`); runtimes
  are adapters behind a transport seam (docs/adr/0002).
- **Seam is `RuntimeAdapter`** (`packages/transport`). The frontend only speaks
  assistant-ui's `useAssistantTransportRuntime` protocol; backend transport-service
  delegates to a registered adapter (docs/adr/0001).
- **`Run` is the atomic traceable unit**; each Research turn produces one.
- **Keep the transport package React-free.** The shared client package
  (`@science-studio/transport-client`) owns the assistant-ui boundary: the
  `useTransport` hook + mount probe, the standing `useTransportWatch` consumer
  (adopts canonical-snapshot pushes — remote turns and native command replies,
  which never stream over a run channel), and the command catalog; the web app
  and the openclaw example both use it, and each app owns only its Thread UI.
- **Don't hand-roll the gateway WS state machine.** Use
  `@openclaw/gateway-client` / `@openclaw/gateway-protocol` primitives, pinned
  EXACTLY (calendar release train, not semver; `2026.8.1`). Reference
  implementation in `viber-space/openclaw-adapter`.

## OpenClaw specifics (backend adapter)

- Connects as an **operator** client with the shared token. **Connect identity
  must be `id: "cli"`, `mode: "cli"`** — `mode: "operator"` is invalid (mode is
  a transport, not a role); the gateway rejects it with `INVALID_REQUEST`.
  Verified against a live gateway (`hello-ok`).
- Verified against a live gateway: connect/handshake, `sessions.list`,
  `chat.history`, `chat.send` (returns `{ runId, status: "started" }`), event
  streaming. **`chat.send` requires a non-empty `message`**; otherwise the
  gateway answers `INVALID_REQUEST: message or attachment required` (schemas in
  `@openclaw/gateway-protocol/protocol.schema.json`).
- Each run is scoped to its own `runId` (`flow.targetRunId`) so stale/foreign
  runs can't end it prematurely. If the LLM provider (ollama) is unreachable,
  runs stall at `starting_model` and never emit content.
- Mapping is verified against real `chat.history` shapes: assistant
  `{type:"thinking",thinking}` + `{type:"text",text}` blocks and `toolResult` rows.
- Do not advertise `session-scoped-events` — it breaks broadcast streaming.

## Operational gotchas

- Gateway URL/token come from `services/transport-service/.env`
  (`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`; dotenv loads it; the file
  is NOT committed). No `.env` → adapter init fails.
- Adapter init failure is logged (`gateway not ready within 15s`) but the
  server keeps listening; every subsequent request fails. Stale `tsx` processes
  hold port 3001 and can wedge the gateway connection — before restarting, kill
  leftovers (`pgrep -fl "transport-service"`, then `pkill`) rather than piling
  up and masking symptoms with "not ready" verbosity.
- `/api/transport` is served by a **streaming Route Handler** that pipes the
  transport-service body straight through (`apps/web/app/api/transport/route.ts`,
  upstream `TRANSPORT_SERVICE_URL` → `localhost:3001`). Don't replace it with a
  `next.config` rewrite — Next buffers rewrite responses, which destroys the SSE
  token stream (symptom: the whole reply — user message included — appears only
  when the run finishes). When debugging a UI-side issue, test through port 3000
  too; the route handler can behave differently from the direct service.
- The web UI is the **assistant-ui registry `Thread`** (`shadcn add
  @assistant-ui/thread`, Radix flavor) on Tailwind v4 + shadcn/ui, not
  hand-written chat markup. To refresh/upgrade the components, run `npx
  shadcn@latest add "@assistant-ui/thread" -y -c apps/web` (components.json
  maps the `@assistant-ui` registry). `app/layout.tsx` must wrap children in
  `TooltipProvider`. Don't restyle elements with inline styles — the styling
  stack is Tailwind utility classes.
- The assistant-ui Thread only starts a request when the user sends a message;
  history on load is handled by the mount probe in `app/page.tsx` (see wire
  contract above) and by `importExternalState`, so don't add `resumeApi`/
  `resumeStateApi` options to the runtime just to fetch history.
- `@science-studio/record` exports `createInMemoryRecordStore()`. The service
  wires it via `toRecordStoreLike` because the authoritative `RecordStore` does
  NOT structurally satisfy the adapter seam `RecordStoreLike`
  (`addArtifact` param mismatch: `Artifact` vs `ArtifactInput`) — don't smuggle
  it in with `as any` or the adapter's `persistRun` fails at runtime.