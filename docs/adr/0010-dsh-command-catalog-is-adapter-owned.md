# The dsh command catalog is adapter-owned

The dsh runtime's slash commands (`/status`, `/new`) are a catalog **the adapter
publishes and answers itself**, not a mirror of the harness's own command
registry. `DshRuntimeAdapter.listCommands()` returns those descriptors, and the
dsh behavior answers a `/`-prefixed message locally — writing an ordinary
assistant row and settling without a `Run` — instead of prompting the agent.

- **Status**: accepted
- **Context**: commands are "/"-prefixed text messages end-to-end, and their
  catalog comes from the runtime (docs/adr/0003). For openclaw that means the
  **gateway's** own `commands.list`, curated by the adapter. dsh has no
  equivalent to proxy: this deployment drives a local harness child over the SDK
  stdio protocol, whose entire method set is `initialize`, `session/prompt` and
  `shutdown` — there is no command list and no command execute, and server→client
  requests are a dead capability. The harness's command registry
  (`@deepseek-ai/dsh-commands`, mounted by the base profile with `/compact`,
  `/plan`, `/goal` and `/feedback`) is an in-process Cordis service that only the
  harness's own UIs reach, through a different wire (`dsh-api-remotes` over the
  web API gateway). A `/compact` sent as a prompt would reach the **model** as
  text, not the registry — the exact "a command line silently downgraded to a
  plain prompt" failure the harness's own command adapter refuses.
  *Considered and rejected*: mounting the API gateway in the child (a second,
  HTTP/WS transport inside a stdio child, contradicting docs/adr/0004), and
  extending the SDK wire (we do not own the server plugin; it dispatches from a
  fixed method table).
- **Decisions**:
  - The catalog is the set of commands the ADAPTER can genuinely execute against
    the session it owns. It is static, and available before the harness child has
    ever started, so the menu and `/status` work even where the harness could not
    launch.
  - A command invocation is answered locally: the adapter emits one assistant
    reply row, returns the session to idle, and settles. `projectRun` projects
    nothing when the Run's input is a command line, so no `Run` is recorded
    (docs/adr/0003) while the mirror still persists the rows — a reload keeps
    them.
  - A command line NEVER reaches the model. An unknown name (`/compact`) and a
    malformed line both get a reply naming what this runtime does answer.
  - The catalog takes no-argument commands only (docs/adr/0003) and says so:
    extra words answer with a usage line rather than being silently dropped.
  - `/new` drops the harness conversation — the harness session id is forgotten
    and the next turn mints a later one in the same child generation — but it
    never clears the transcript. The record keeps every Run, and the transcript
    keeps showing what was said; the agent simply no longer sees it, which is the
    same divergence a service restart already produces.
- **Consequences**: every capability the runtime does not expose (context
  condensation, model switching, plan mode) stays OUT of the dsh menu rather than
  appearing and failing. The catalog is a product surface with an owner — the dsh
  adapter — so extending it means implementing the command, not wiring one up.
  `/new` abandons a harness session in the (durable, never-pruned) harness home,
  which grows by one log per reset; the SDK wire offers no session delete.
