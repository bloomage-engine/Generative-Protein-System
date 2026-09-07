# Backend assistant-transport service

We chose a **backend assistant-transport service**: the frontend talks only to a
uniform transport protocol, and a backend service translates it to a concrete
agent runtime (openclaw today, codex and others later) behind a `RuntimeAdapter`
seam. The frontend assistant-ui Thread is never rewritten when the runtime
changes.

The existing `openclaw-adapter` is factored as a frontend-side library (browser
connects directly to the gateway WebSocket via `useExternalStoreRuntime`). We
deliberately move that logic server-side so that swapping runtimes never touches
the UI, accepting one extra service in exchange for decoupling the frontend from
any runtime.

- **Status**: accepted
- **Considered options**:
  - *Frontend-side adapter (status quo of openclaw-adapter)* — one less service,
    but every runtime needs a frontend transport, so switching runtimes changes
    the frontend. Rejected because it conflicts with the "frontend never changes"
    goal.
  - *Backend transport service (chosen)* — frontend stays fixed; runtimes are
    swappable adapters behind one seam.
