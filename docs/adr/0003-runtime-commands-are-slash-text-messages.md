# Runtime commands are "/"-prefixed text messages

Runtime commands (openclaw slash commands today) are surfaced to the assistant-ui
Thread as **ordinary user text messages beginning with `/`** — not as a new wire
command type. The transport seam (`TransportCommand`, `RuntimeAdapter.run`) is
unchanged; the frontend slash menu is a pure UI layer over the existing send
path, and an adapter decides what a `/`-prefixed message means inside its own
runtime. A command is **not** a research turn: adapters never persist a `Run`
whose driving user text starts with `/`.

- **Status**: accepted
- **Context**: openclaw executes slash commands when a standalone message
  starting with `/` reaches the gateway; there is no dedicated command-execution
  RPC, and `chat.history` rows carry no marker distinguishing a command message
  from a research message. The gateway owns the conversation, so a command
  invocation and its reply will appear in the transcript and in reconcile like
  any other turn — attempting to hide them would require fragile `/`-prefix
  filtering during history sync and would fight the convergence model.
- **Decisions**:
  - Commands are visible Thread content (user `/cmd` row + assistant reply),
    identical in shape to research messages; reconcile/`syncFromHistory` treat
    them exactly like any other gateway rows.
  - "Command" is a seam-level rule, not a type: any user message whose text
    starts with `/` is a command message, whether it came from the slash menu, a
    hand-typed message, or a remote client (e.g. the openclaw TUI). `Run`
    persistence is skipped for such messages: local command runIds are tracked
    precisely, and remote settles are persisted only after the `chat.history`
    sync (whose transcript guard skips settles whose immediately preceding user
    row starts with `/`), so a remote command turn never becomes a research
    `Run` — which also attributes remote research turns to their real input.
  - The slash menu's command catalog comes from the runtime: `RuntimeAdapter`
    gains an optional `listCommands()` returning runtime-agnostic
    `CommandDescriptor`s. The openclaw adapter proxies the gateway's own
    `commands.list` and curates it (native text commands on a v1 allowlist; the
    gateway's report still gates availability). The catalog is served over a
    separate `GET /api/transport/commands` endpoint fetched in parallel with the
    mount probe, so the frontend never hardcodes a runtime's command set — a
    future runtime brings its own catalog and its own adapter-side mapping.
  - The menu runs no-argument commands only, and only while the thread is idle
    (running research turns disable the menu); commands needing required
    arguments are curated out of v1. `/stop`/`chat.abort` wiring is deferred
    with the adapter's run-abort work.
- **Considered options**:
  - *Structured `run-command` transport command* — a new `TransportCommand`
    variant plus client-side send support for non-message batches. Rejected:
    the gateway executes commands only as `/` text over `chat.send`, history
    cannot distinguish command rows, and every v1 behavior (echo, reconcile,
    skip-`Run`) falls out of the text model with zero new protocol. A typed
    vocabulary can be added to the seam when a concrete runtime needs it.
  - *Console model (commands kept out of the transcript)* — rejected: it
    requires heuristic filtering of gateway history rows and contradicts the
    gateway-owned-conversation architecture rule (docs/adr/0002).
