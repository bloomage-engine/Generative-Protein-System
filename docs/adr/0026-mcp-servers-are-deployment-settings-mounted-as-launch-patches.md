# MCP servers are deployment settings mounted as launch patches

The pinned harness already SHIPS an MCP client: `@deepseek-ai/dsh-mcp-client` is a
dependency of the `@deepseek-ai/dsh` CLI, a cordis plugin that connects to one
external MCP server per config row and registers its tools model-facing as
`mcp__<serverName>__<tool>` (stdio or Streamable HTTP; tools only — MCP
prompts/resources are outside the plugin). But the `sdk` profile does not mount
it, and the product had no way to say WHICH servers a deployment connects to.
This ADR closes that loop: an `mcp` section in the deployment settings file, an
MCP tab in the workbench dialog, and one more per-launch patch in the dsh
adapter — the seventh — whose rows are NOT science-studio plugins but the
harness's own package.

- **Status**: accepted (extends docs/adr/0011's launch-patch mechanism and
  docs/adr/0015's service-owned settings)
- **Context**: researchers want external tools (GitHub, browsers, vendor APIs)
  that already speak MCP, without science-studio re-implementing each one.
  *Considered and rejected*: per-Project server lists (a `.science-studio/mcp.*`
  workspace file like the HPC binding, docs/adr/0024) — a server connection is a
  machine/deployment fact, its credentials do not belong in a directory that is
  copied and recycled with the Project, and the first release needs no
  per-Project variance. *Considered and rejected*: editing the harness's own
  profile files under `~/.dsh` — the product already composes the child's plugin
  tree per launch, and durable profile edits would leak deployment config into a
  shared home and fight the per-(Project, Worktree) child model.
  *Considered and rejected*: the service acting as the MCP client and relaying
  tools over its own surface — the harness's plugin already does the bridging
  (naming, reconnection, image projection, tool-list resync); a second client in
  science-studio would drift from it.
- **Decisions**:
  - **The server list is deployment settings.** `RuntimeSettings.mcp:
    { servers: McpServerSettings[] }` in the service settings file
    (docs/adr/0015), with the types in the seam package; the `PUT /api/settings`
    manager gate is the trust boundary. A row's fields are the MINIMAL plugin
    set: `serverName`, `transport` (`stdio` | `streamable-http`), `enabled?`
    (absent = true), and per transport `command/args/env/cwd` or `url/headers`;
    the plugin's advanced fields (timeouts, reconnect budget,
    `failOnStartupError`, instruction cap) take the plugin's own fail-soft
    defaults, so a slow or broken server delays nothing and kills nothing.
  - **Server secrets are write-only over HTTP.** The GET view replaces `env` /
    `headers` VALUES with their configured KEY names (`envConfigured`/
    `headersConfigured` — names are not secrets and the form needs them); the
    `PUT` merges per key against the stored row: absent keeps, `null` deletes, a
    string replaces. Row identity is `serverName`, so a rename or a transport
    switch is a NEW row and the old row's secrets do not follow it (the form
    warns); a removed row takes them with it. This generalizes docs/adr/0015's
    `apiKey` rule from one string to a map.
  - **The validator speaks the plugin's grammar.** `serverName` must match
    `[A-Za-z0-9_-]{1,32}` (the plugin's namespace rule) and be unique across the
    list including disabled rows (the plugin fails a duplicate at LOAD time,
    inside the child, where nobody would read it); `url` must be http(s);
    `args`/`env`/`headers` keep their types; unknown fields on a row are a 400,
    never a silent drop — a typo'd field means a server that will not work.
    `command`/`args` take NO argv grammar (contrast `validateHpcEndpoint`,
    docs/adr/0024): they are spawned directly as the deployment's own chosen
    process, and a settings writer can execute arbitrary code by definition —
    the manager gate is the boundary, not the string shape.
  - **The list flows per acquisition, not per boot and not live.** The model
    section is boot-folded (a service restart applies); the hpc section is read
    per request (applies immediately); MCP config must be in the CHILD's launch,
    so it takes the middle rule: `composition.environmentFor` re-reads the
    settings file at each acquisition and passes the stored list through a new
    OPTIONAL `RuntimeInitOptions.mcpServers` field (not `DshBinding` — the
    binding is boot-time material). A child spawned after a save mounts the
    current list; a cached child keeps its launch-time one until its
    environment is released (service restart, Project/Worktree lifecycle). The
    dialog says so verbatim: "applies to newly launched dsh processes".
  - **Mounting is the seventh launch patch, and it mounts for EVERY child.**
    `writeMcpPatch` writes one `insert` section with one row per ENABLED server:
    `id: science-studio-mcp-<serverName>`, `name:
    "@deepseek-ai/dsh-mcp-client"` — a BARE package specifier, not a `file:`
    URL, because the package ships in the dsh CLI's own install closure (the
    first resolution anchor of `dsh-app-boot`). Unlike the Project-bound
    siblings it is not gated on `opts.project`: it is a deployment capability
    and `project-default` gets it too. An empty or all-disabled list writes no
    file; a failed write is best-effort-soft like every sibling.
  - **Because the patch embeds plaintext secret values, the launch-patch dir is
    owner-only.** The shared bridge directory is created/`chmod`-ed 0700 and
    every patch file (all seven writers, not only MCP) lands 0600. The child
    runs as the same user, so nothing legitimate loses access.
  - **`/status` reports the mounted subset.** One extra line — `- mcp:
    `github` (stdio), `web` (streamable-http)` or `none mounted` — a patch
    MOUNT fact read from adapter state, no child touched, no connection probed,
    and never a secret value. There is deliberately NO service-side MCP probe
    (contrast the HPC endpoint Test): it would be a second client whose verdict
    could differ from the child's real behavior; connectivity shows up as
    missing `mcp__*` tools in the agent's next turn.
- **Consequences**: the workbench dialog gains an MCP tab after HPC (editable
  under any runtime with a hint that only dsh consumes it — the section is
  settings, not an adapter surface, so there is no `available: false` case,
  docs/adr/0021). The `RuntimeInitOptions` addition is optional and additive:
  openclaw ignores it, no `contract-tests` suite changes. The mounted rows
  reach the parent's plugin tree, so a delegated subagent inherits the same MCP
  tools (harness behavior, documented here rather than duplicated). The
  harness's companion `mcp-resources` package is NOT mounted — this is tools
  only, matching the plugin README's scope. A row whose connection fails at
  startup stays invisible until the server recovers (the plugin reconnects with
  its budget); the settings file is the audit trail of what was configured, and
  the child log is the record of what connected.
