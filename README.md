# Science Studio

A research-agent platform for computational life-science R&D. Researchers and
managers run and observe agent-driven work with full traceability: every agent
action lands as a reproducible, attributable research record.

## Status

Early framework. The domain model, system architecture, and ADRs are in place;
the monorepo skeleton is scaffolded. The frontend renders an assistant-ui Thread
over the assistant-transport protocol; the backend exposes a transport-service
and an openclaw runtime adapter.

Working today:

- Live assistant-ui Thread (`apps/web`, port 3000) ↔ transport-service (port
  3001) ↔ openclaw gateway (SSE streaming, `set`-op state updates). The chat UI
  is the Thread component registered from the assistant-ui registry (Tailwind
  v4 + shadcn/ui; see `components/assistant-ui`).
- **Session history loads on page open** — the web app fires a mount-time probe
  and the service reconciles every client against its canonical transcript, so
  prior messages render on first load and after reloads.
- The openclaw adapter's connection/RPCs/streaming are verified against a live
  gateway. Generation requires the gateway's LLM provider to be reachable — see
  `AGENTS.md`.

## Repository layout

```
science-studio/
├── apps/
│   └── web/                          Next.js frontend (assistant-ui Thread UI, :3000)
│       ├── app/                      layout + page (renders the registered assistant-ui Thread)
│       ├── components/assistant-ui/  Thread elements from the assistant-ui registry
│       ├── components/ui/            shadcn/ui base components (button, tooltip, …)
│       ├── hooks/                    registry helpers (clipboard, attachment src)
│       └── lib/                      transport runtime hook, session probe, cn util
├── packages/
│   ├── record/                       domain + record layer (Run is the atomic unit)
│   ├── transport/                    runtime-agnostic seam (RuntimeAdapter, StateDelta)
│   └── transport-openclaw/           openclaw runtime adapter (backend operator client)
├── services/
│   └── transport-service/            backend assistant-transport service (SSE, :3001)
├── scripts/                          dev smoke tools (see Commands)
├── docs/
│   ├── architecture.md               system architecture
│   └── adr/                          0001 backend transport, 0002 record ownership
├── CONTEXT.md                        domain glossary (authoritative vocabulary)
└── AGENTS.md                         repo & wire-contract operational notes
```

## Commands

```bash
npm install            # install all workspaces
npm run build          # build record → transport → transport-openclaw → transport-service (type gate)
npm run dev            # transport-service (:3001) + web (:3000) together
npm run dev:service    # transport-service only
npm run dev:web        # web only
npm run smoke:adapter  # drive one chat.send against a live gateway (needs build + .env)
npm run smoke:replay -- <frames-file>   # fold captured SSE frames through the client decoder
```

> `npm run typecheck` is **known-broken** in transport-service (pre-existing
> TS6310: composite refs + `--noEmit`); other workspaces pass. Use `npm run
> build` for the service. There is no test suite yet (`npm test` is a no-op).

## Getting started

```bash
npm install
npm run build
npm run dev
```

Open http://localhost:3000. The web app streams from `/api/transport`, served
by a streaming Route Handler that pipes the transport-service body through
(`app/api/transport/route.ts`), so the UI stays same-origin and SSE token
streams survive. The openclaw adapter needs a reachable OpenClaw gateway
(`OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` in
`services/transport-service/.env`) and a working LLM provider — the configured
provider (ollama) must be up or runs stall at `starting_model`.

Verify the service without the browser:

```bash
curl -sN -X POST http://localhost:3001/api/transport \
  -H 'content-type: application/json' \
  -d '{"commands":[],"state":{"status":"idle","messages":{}},"threadId":null}'
```

A session with history streams a full state snapshot (one `set` on `messages`)
and must terminate with `data: [DONE]`.

## Domain vocabulary

See `CONTEXT.md` — it is the authoritative glossary (`Project`, `Study`, `Task`,
`Run`, `Artifact`, `Evidence`, `Conclusion`, `AgentBlueprint`, `Session`,
`Workflow`).
