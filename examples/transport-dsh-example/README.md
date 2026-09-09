# transport-dsh · assistant-ui example

A minimal, runnable example showing a **DeepSeek Harness** runtime — driven by
**`@science-studio/transport-dsh`** — rendered in **assistant-ui**. It is the
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
  primitives (no Tailwind/shadcn). It consumes `@science-studio/transport-client`
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
  `0.1.5-alpha.1` — a pre-release; docs/adr/0004). You need a real
  `DEEPSEEK_API_KEY` for a live run.
- **Step-granular rendering**: dsh pushes committed session events, not token
  fragments — each `assistant/message` lands as a whole (per model step, tools
  included). Replies appear per step rather than per token. This is the
  protocol's honest granularity; nothing is synthesized.
- **Tool calls** still coalesce into one part per `callId` (start + result
  merged), exactly like openclaw.
- **Cold starts**: the adapter keeps its own transcript mirror (see
  `DSH_TRANSCRIPT_DIR`) so history survives service restarts without reading
  dsh's internal session log.

## Prerequisites

- A DeepSeek API key (`DEEPSEEK_API_KEY`); the harness needs it to reach the
  LLM provider behind the session. No key → the runtime starts but turns never
  produce content (or fail on model request).
- `npm install` at the repo root, then `npm run build` (the example imports
  `@science-studio/transport-dsh` and `@science-studio/transport-service`
  from their dist builds).

## Run

```bash
cd examples/transport-dsh-example
cp .env.example .env        # fill in DEEPSEEK_API_KEY (no DSH_* keys — see below)
npm run dev                 # server on :3300 + Vite dev server on :5173
```

**`DSH_*` variables are launch-only.** The harness child runs with this folder
as its cwd, so the dsh CLI boot layer reads this same `.env` — and refuses any
`.env` file that sets a `DSH_*` (or `XDG_*`/`DYLD_*`) name, `export DSH_*`
instead of putting it in `.env`. Defaults when nothing is set: profile `sdk`,
home `~/.dsh`, provider `deepseek-official`, model `deepseek-v4-flash`, agent
workspace = this folder, transcript mirror under the service tmp dir. For
overrides:

```bash
export DSH_HOME=~/.dsh          # durable dsh session log root (default ~/.dsh)
export DSH_TRANSCRIPT_DIR=…      # Science Studio transcript mirror
npm run dev
```

Open **http://localhost:5173** and send a message. The first message spawns the
`dsh` child (a few seconds), so the first reply is slower than later ones.

`npm run build` type-checks (`tsc --noEmit`) and bundles the client with Vite.
This example is dev-only and intentionally NOT part of the root `npm run build`
gate.

## Manual verification checklist

Against a live dsh runtime (real API key), verify in the browser:

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
npm run test -w @science-studio/transport-dsh-example
```

Two cases, all over real HTTP + SSE on an ephemeral port, against a scripted
turn client:

- an **`add-message` run** streams the scripted reply as `set` ops between
  `running` → `idle` status flips — including a tool-call step whose result is
  coalesced into the tool-call part via a `parts` set — terminating with
  `[DONE]`;
- a follow-up command-less **probe** re-converges to the full transcript (the
  claimed state drifted) and terminates with `[DONE]`.
