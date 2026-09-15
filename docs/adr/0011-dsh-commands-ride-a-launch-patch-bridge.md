# dsh commands ride a launch-patch bridge

The dsh runtime's slash menu carries **two layers**: the commands the adapter
answers from its own state (`/status`, `/new`) and the **harness's OWN registry**
(`/compact`, `/plan`, `/goal`, `/feedback`, `/permission`), reached through a
bridge plugin this package ships into its harness child via a per-launch profile
patch. Either way a command is an ordinary assistant row, never a `Run`, and the
menu is complete from the first page load — while the harness is cold it serves
a curated list of the pinned profile's own commands.

- **Status**: accepted
- **Context**: commands are "/"-prefixed text messages end-to-end, and their
  catalog comes from the runtime (docs/adr/0003). docs/adr/0010 established that
  dsh's SDK stdio wire (`initialize`/`session/prompt`/`shutdown`) has no command
  plane, so the adapter published and answered its own two commands — correct,
  but it left the harness's real registry (`@deepseek-ai/dsh-commands`, which
  the `sdk` profile's base mounts with `/compact`, `/plan`, `/goal`,
  `/feedback` and `/permission`) invisible to the product, because that registry
  is an in-process Cordis service that only the harness's own UIs reach.
  *Considered and rejected*: mounting `dsh-api-remotes` + `dsh-api-gateway` in
  the child (a whole browser-facing HTTP/WS API inside a stdio child, which
  docs/adr/0010 already rejected), and extending the SDK wire (we do not own the
  server plugin; its `handleRequest` switch is fixed). The `agent/pre-step`
  waterfall could intercept a `/`-prefixed *prompt*, but it gives the catalog no
  inbound path and leaves the interception semantics (what a rejected pre-step
  does to the turn, whether the row reaches the session log) unverified.
- **Decisions**:
  - **The bridge is a launch artifact, not a second transport.**
    `bridge-plugin.ts` is a cordis plugin in this package's own build output.
    The adapter writes a one-entry profile patch (`--patch <file>`, supported by
    `@deepseek-ai/dsh-sdk-client`'s `resolveDshLaunch`) that inserts it by
    `file:` URL, with the socket path as its config; the plugin serves
    `GET /commands` and `POST /execute` on a **process-private UNIX socket**
    (owner-only mode, unique per adapter init, removed with the child). The
    plugin stays dependency-free and never writes to stdout — the child's stdout
    is the JSON-RPC wire — and it fails SOFT: a missing config or a failed bind
    logs one stderr line and leaves the child running without a bridge, because a
    throwing plugin fails the whole boot.
  - **Local commands win their names.** `/status` and `/new` must work where the
    harness could not launch at all, so they are answered by the adapter and a
    harness command of the same name is dropped from the menu (and never
    forwarded). One rule serves both the catalog and execution.
  - **A catalog request never starts the child; a user-issued command does.**
    Listing is read-only, so with no child ever started for this Project the
    catalog is just the local pair; a command is a deliberate request to use the
    runtime, so it boots the child first. The harness catalog is TTL-cached with
    one inflight refresh and stale-on-empty failure, like the openclaw adapter's
    gateway catalog.
  - **An execution targets one EXACT agent — and a session that has none yet gets
    one.** The registry runs a command against a single agent, so a line is NEVER
    run against whatever agent happens to be newest. A session this child has no
    agent for (it has not prompted yet, or `/new` dropped its conversation) is
    the `cold` handoff instead: the SDK wire's only agent-creating verb is a
    prompt, so the line IS driven as that session's first prompt, and the bridge
    plugin intercepts it at `agent/pre-step` — the harness's own registry runs it
    and the step is REJECTED, so the turn ends `blocked` with no model call. That
    makes a command usable on a fresh session, and what it set up (plan mode, a
    goal, a permission preset) is in force BEFORE the conversation's first model
    request — which is what `/plan` and `/goal` are for. The reply is the
    harness's own `command/done`; a line its registry does not resolve (the one
    thing the curated cold catalog can get wrong) is answered with the existing
    `Unknown command …` line rather than left silent.
    *Considered and rejected*: creating the agent from the plugin
    (`ctx.agents.create`) and running the command against it. The SDK server only
    knows the sessions IT created (`getOrCreateSession` → `ctx.agents.create`),
    so a pre-created agent makes the session's first real prompt fail with
    `session "<id>" already exists` — stranding the command's state (plan mode,
    the goal) on an agent nothing else ever talks to.
  - **Commands never become `Run`s.** The reply is an ordinary assistant row, the
    session settles, and `projectRun` still projects nothing for a command input
    (docs/adr/0003) — a `/plan <message>` that submits a prompt arrives as
    ambient events and records no `Run` either, because dsh never reports a run id
    for it.
  - **The menu is complete while the runtime is cold — from a curation, not from
    a process.** The harness's registry is agent-scoped (`list(agent)` and
    `find(agent, name)` both resolve through the receiving agent) and no agent
    exists until a session prompts, so a cold runtime cannot enumerate it at all.
    Without a cold layer the menu would show only the adapter's own two commands
    until the first message — and again after every service restart, which kills
    the child. So the harness layer is the LIVE catalog when it answers with
    anything, and otherwise a curated list of the pinned profile's own commands
    (`DSH_HARNESS_FALLBACK_DESCRIPTORS`: compact, feedback, goal, permission,
    plan), exactly the way the openclaw adapter curates its gateway catalog. This
    is a NARROW exception to docs/adr/0010's rule that a capability the runtime
    does not expose stays out of the menu: the curation is version-tied to the
    exactly-pinned harness, it yields the moment the registry can be read (a
    command the harness dropped leaves the menu again), and a name it gets wrong
    answers with the existing `Unknown command …` line rather than failing.
  - **A catalog request still never starts the child.** The curation exists
    precisely so the menu needs no process: listing stays read-only, and a
    user-issued command remains the only thing that boots the harness (where a
    harness cannot launch, the curated rows answer `unavailable` instead).
  - **A slow command keeps the run open.** The behavior's command answer is
    async and the kit awaits the settle pipeline before ending the stream, so
    `/compact` shows the running state for its duration instead of a reply that
    appears after the stream closed.
  - **The cold command prompt is the one thing the harness must help with.** The
    interception is a second claim this package makes without asking: it needs
    `agent/pre-step` to exist, to carry the claimed messages, and to honour a
    `{ kind: 'reject' }` decision. A pin that moves either leaves the bridge
    plugin healthy (the registration cannot fail loudly — an event name is not
    validated at registration) and the line would then reach the MODEL as a
    prompt. It is therefore the thing a pin move must be re-checked against,
    together with the curated cold catalog: `scripts/smoke-dsh-command-bridge.mjs`
    drives a REAL child through a cold `/plan` and asserts the turn ends `blocked`
    with a `command/done` and NO assistant message, and that the following prompt
    logs `plan/mode`. What is verified there is the harness's side; the adapter's
    side is pinned by `harness-commands.test.ts`.
  - **The menu refreshes when the thread goes idle.** A runtime whose catalog only
    exists once it is warm cannot report it before the first run, so the web
    composer re-reads the catalog on the running→idle edge (`useRuntimeCommands`
    takes an optional refresh token). A change of (api, Project) still clears the
    list; a refetch keeps the last resolved catalog on screen, so the menu never
    blinks off. The hook does not read thread state itself — it is a public export
    that must work without an assistant-ui provider.
- **Consequences**: the dsh menu is now the harness's own product surface, so a
  harness release that adds a command adds a menu row with no change here — and
  one that renames the registry's `list`/`execute`, or the agent registry's
  lookup (the pinned `0.1.5-alpha.1` spells the top-level listing `roots`),
  degrades to an `unavailable`/empty catalog rather than a crash, because the
  plugin's structural types are the only place that knows those shapes. The
  curated cold layer is the one claim this package makes about the harness
  WITHOUT asking it, so it is the one thing to re-read when the pin moves: a
  wrong name there shows a menu row that answers `Unknown command …`.
  Commands that need arguments have no menu affordance in v1 (the menu sends the
  bare invocation; type `/plan <message>` by hand), and `/compact` blocks the
  composer while it runs — the harness's own UI behaves the same way. The
  socket-path length is a recorded foot-gun: `sun_path` is 104 bytes on macOS and
  `tmpdir()` is already ~47 there, so the unique part is short by design.
  Windows uses a named pipe (unverified); should it misbehave, the pre-decided
  degradation is to disable the bridge on `win32` and keep the local pair.
