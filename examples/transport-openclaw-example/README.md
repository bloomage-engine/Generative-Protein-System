# transport-openclaw · assistant-ui example

A minimal, runnable example showing the OpenClaw gateway's conversation —
driven by **`@science-studio/transport-openclaw`** — rendered in
**assistant-ui**. It is the shortest end-to-end path through the platform's
three layers, with no protocol code of its own:

```
┌────────────────────┐   gateway WS    ┌─────────────────────────┐
│ OpenClaw gateway   │◄───────────────►│ OpenClawRuntimeAdapter  │
└────────────────────┘                 │ (@transport-openclaw)   │
                                       └───────────┬─────────────┘
                                                    │ StateDelta stream
                                       ┌────────────▼─────────────┐
                                       │ @transport-service       │
                                       │ (reconcile-first wire:   │
                                       │  set / append-text ops,  │
                                       │  SSE, [DONE] termination)│
                                       └────────────┬─────────────┘
                                                    │ SSE over /api/transport
                                       ┌────────────▼─────────────┐
                                       │ assistant-ui             │
                                       │ useAssistantTransport-   │
                                       │ Runtime + ThreadPrimitive│
                                       └──────────────────────────┘
```

- **Server** — [`server.ts`](./server.ts) is ~20 lines: register the real
  adapter and hand it to `createTransportService`. The service owns the entire
  wire contract (reconcile-first history snapshots, client-safe op types,
  `[DONE]` termination, the standing watch endpoint).
- **Client** — [`src/`](./src/) is a Vite + React app on assistant-ui core
  primitives (no Tailwind/shadcn). It consumes `@science-studio/transport-client`
  (the `useTransport` hook: transport runtime, message converter, and the mount
  probe that loads the session's history on first paint); `App.tsx` renders the
  thread with assistant-ui's default part renderers (text, streaming, reasoning,
  tool-calls).
- **Tests** — [`test/example.test.ts`](./test/example.test.ts) drives the same
  wiring against a **scripted gateway** (the adapter's `createGateway` test
  seam, as in `packages/transport-openclaw/test/`) — no live gateway needed.

## Prerequisites

- A running OpenClaw gateway (URL + shared token). The reference for a working
  pair is `services/transport-service/.env` (`OPENCLAW_GATEWAY_URL`,
  `OPENCLAW_GATEWAY_TOKEN`); the LLM provider behind the session (e.g. ollama)
  must be reachable, or runs will stall at `starting_model`.
- `npm install` at the repo root, then `npm run build` (the example imports
  `@science-studio/transport-openclaw` and `@science-studio/transport-service`
  from their dist builds).

## Run

```bash
cd examples/transport-openclaw-example
cp .env.example .env        # fill in OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN
npm run dev                 # server on :3200 + Vite dev server on :5173
```

Open **http://localhost:5173** and send a message.

`npm run build` type-checks (`tsc --noEmit`) and bundles the client with Vite.
This example is dev-only and intentionally NOT part of the root `npm run build`
gate.

## Manual verification checklist

Against a live gateway, verify in the browser:

1. **History on load** — a session with prior turns renders its full
   transcript immediately (the mount probe); a page reload re-converges to the
   same history (reconcile-first).
2. **Token streaming** — the assistant reply appears as tokens stream in
   (small `append-text` ops, not whole-message rewrites).
3. **Tool calls** — a run that invokes tools renders one tool-call part per
   `toolCallId`, start + result merged, in event order; in-flight tools show a
   running state (spinner) until the result lands.
4. **Reasoning** — thinking streams collapse into a single reasoning part that
   updates in place.
5. **Run settlement** — the composer unlocks when the run ends; the stream
   always terminates (`[DONE]`), even for a no-command probe.

## Tests (no gateway required)

```bash
# from the repo root (after npm run build)
npm run test -w @science-studio/transport-openclaw-example
```

Two cases, both over real HTTP + SSE on an ephemeral port:

- a command-less **probe** converges to the scripted gateway's `chat.history`
  (both the user and assistant rows) and terminates with `[DONE]`;
- an **`add-message` run** streams the scripted reply as `set` + `append-text`
  ops (exact part path asserted) between `running` → `idle` status flips,
  terminating with `[DONE]`.
