# transport-dsh · assistant-ui example

A minimal, runnable example showing a **DeepSeek Harness** runtime — driven by
**`@gps/transport-dsh`** — rendered in **assistant-ui**. It is the
shortest end-to-end path through the platform's three layers, with no protocol
code of its own:

```
┌────────────────────────────┐   child process    ┌───────────────────────┐
│ dsh --profile sdk (local)  │◄──stdio JSON-RPC──►│ DshRuntimeAdapter     │
│ (spawned by @deepseek-ai/  │  (session.event    │ (@transport-dsh)      │
│  dsh-sdk-client)           │   notifications)   └───────────┬───────────┘
└────────────────────────────┘                                 │ StateDelta stream
                                                               ▼
                                                  ┌────────────────────────┐
                                                  │ @transport-service      │
                                                  │ (reconcile-first wire:  │
                                                  │  set / append-text ops, │
                                                  │  SSE, [DONE] termination)│
                                                  └───────────┬────────────┘
                                                              │ SSE over /api/transport
                                                  ┌───────────▼────────────┐
                                                  │ assistant-ui            │
                                                  │ useAssistantTransport-  │
                                                  │ Runtime + ThreadPrimitive│
                                                  └─────────────────────────┘
```

- **Server** — [`server.ts`](./server.ts) is ~20 lines: register the real
  adapter and hand it to `createTransportService`. The service owns the entire
  wire contract (reconcile-first history snapshots, client-safe op types,
  `[DONE]` termination, the standing watch endpoint).
- **Client** — [`src/`](./src/) is a Vite + React app on assistant-ui core
  primitives (no Tailwind/shadcn). It consumes `@gps/transport-client`
  (the `useTransport` hook: transport runtime, message converter, and the mount
  probe that loads the session's history on first paint) plus the standing
  `useTransportWatch` consumer. There is no runtime slash-command menu here:
  the dsh SDK runtime exposes no command catalog, so `GET
  /api/transport/commands` returns an empty catalog and the composer's "/"
  trigger stays closed.
- **Tests** — [`test/example.test.ts`](./test/example.test.ts) drives the same
  wiring against a **scripted dsh turn client** (the adapter's `createClient`
  test seam) — no live dsh process needed.

## Runtime differences vs the openclaw example

- **Local harness, not a gateway**: the adapter spawns `dsh --profile sdk`
  (same version as `@deepseek-ai/dsh-sdk-client`, pinned exactly
  `0.1.5-alpha.1` — a pre-release; docs/adr/0004). The session's model route is
  the example's `.env` (`HARNESS_PROVIDER`/`HARNESS_MODEL`, default: a LAN
  ollama — see [Model route](#model-route)).
- **Step-granular rendering**: dsh pushes committed session events, not token
  fragments — each `assistant/message` lands as a whole (per model step, tools
  included). Replies appear per step rather than per token. This is the
  protocol's honest granularity; nothing is synthesized.
- **Tool calls** still coalesce into one part per `callId` (start + result
  merged), exactly like openclaw.
- **Cold starts**: the adapter keeps its own transcript mirror (see
  `DSH_TRANSCRIPT_DIR`) so history survives service restarts without reading
  dsh's internal session log.
- **Restart memory caveat**: the pinned SDK's `session/prompt` is
  CREATE-ONLY — a fresh harness child cannot create a session id a previous
  process already persisted in the dsh home (`session "<id>" already
  exists`). Each child therefore mints its harness session ids in its own
  generation, so a restart's first turn is creatable straight away (no
  rejected prompt, no error in the log). The UI transcript still survives
  restarts (our mirror), but the AGENT's memory of pre-restart turns does not
  — after a service restart the agent only sees your current message.

## Prerequisites

- A reachable model route. The example ships pointed at a LAN ollama
  (`HARNESS_PROVIDER=ollama-local`, `HARNESS_MODEL=qwen3.8:latest`); the route
  itself is declared harness-side — see [Model route](#model-route). An
  unroutable or unreachable model → the runtime starts, turns fail.
- A DeepSeek API key (`DEEPSEEK_API_KEY`) for the DeepSeek-backed plugins the
  sdk profile mounts (session log, web search). It is unrelated to which model
  answers the session.
- `npm install` at the repo root, then `npm run build` (the example imports
  `@gps/transport-dsh` and `@gps/transport-service`
  from their dist builds).

## Model route

Which provider/model a session runs on is the example's `.env`
(`HARNESS_PROVIDER`/`HARNESS_MODEL`); `server.ts` promotes those two names to
the adapter's launch environment (`DSH_PROVIDER`/`DSH_MODEL`) before the
adapter reads it, and an exported `DSH_*` still wins. The **route** they name —
endpoint, wire protocol, model catalog — is harness configuration and lives in
the harness home, not in this repo:

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    ollama-local:
      api: openai-completions
      baseURL: http://localhost:11434/v1
      models: [{ id: qwen3.8:latest }]
      apiKeyEnv: OLLAMA_LOCAL_API_KEY
```

`apiKeyEnv` is a credential NAME resolved per request through the harness
launch environment (inherited process env > this folder's `.env` >
`~/.dsh/.env`) — ollama ignores the value, but a route that names a credential
and resolves nothing fails every request with `MISSING_CREDENTIAL`, hence
`OLLAMA_LOCAL_API_KEY` in `.env`.

## Run

```bash
cd examples/transport-dsh-example
cp .env.example .env        # model route + keys (NO DSH_* keys — see below)
npm run dev                 # server on :3300 + Vite dev server on :5173
```

**`DSH_*` variables are launch-only.** The harness child runs with this folder
as its cwd, so the dsh CLI boot layer reads this same `.env` — and refuses any
`.env` file that sets a `DSH_*` (or `XDG_*`/`DYLD_*`) name. That is why the
model route is spelled `HARNESS_PROVIDER`/`HARNESS_MODEL`; for the other
launch settings, `export DSH_*` instead of putting it in `.env`. Defaults when
nothing is set: profile `sdk`, home `~/.dsh`, agent workspace = this folder,
transcript mirror under the service tmp dir, and the adapter's own
`deepseek-official`/`deepseek-v4-flash` when `HARNESS_*` is unset. For
overrides:

```bash
export DSH_HOME=~/.dsh           # durable dsh session log root (default ~/.dsh)
export DSH_TRANSCRIPT_DIR=…      # Generative Protein System transcript mirror
export DSH_PROVIDER=deepseek-official DSH_MODEL=deepseek-v4-flash
npm run dev
```

Open **http://localhost:5173** and send a message. The first message spawns the
`dsh` child (a few seconds), so the first reply is slower than later ones.

`npm run build` type-checks (`tsc --noEmit`) and bundles the client with Vite.
This example is dev-only and intentionally NOT part of the root `npm run build`
gate.

## Manual verification checklist

Against a live dsh runtime (reachable model route + key), verify in the browser:

1. **History on load** — a session with prior turns renders its full
   transcript immediately (the mount probe); a page reload re-converges to the
   same history (reconcile-first). Restart the example server and reload: the
   transcript survives via the adapter's mirror file.
2. **Step-granular replies** — the assistant reply appears when each model
   step commits (whole message per step; tool calls rendered inline). Reasoning
   traces (if the model emits them) appear in the collapsible panel.
3. **Tool calls** — a run that invokes tools renders one tool-call part per
   `toolCallId`, start + result merged.
4. **Run settlement** — the composer unlocks when the run ends; the stream
   always terminates (`[DONE]`), even for a no-command probe. Failed turns
   (e.g. bad model name) surface as an error state on the thread — and are
   still recorded as `Run`s.
5. **No slash menu** — typing "/" does not open a menu (dsh exposes no runtime
   command catalog); "/"-prefixed text is just a prompt.

## Tests (no dsh process required)

```bash
# from the repo root (after npm run build)
npm run test -w @gps/transport-dsh-example
```

Two cases, all over real HTTP + SSE on an ephemeral port, against a scripted
turn client:

- an **`add-message` run** streams the scripted reply as `set` ops between
  `running` → `idle` status flips — including a tool-call step whose result is
  coalesced into the tool-call part via a `parts` set — terminating with
  `[DONE]`;
- a follow-up command-less **probe** re-converges to the full transcript (the
  claimed state drifted) and terminates with `[DONE]`.
