# MCP is a dsh client capability with a deployment-scoped server catalog

Science Studio lets the dsh agent call tools from external **MCP servers**. It
does not implement the Model Context Protocol itself: the pinned dsh harness
already ships `@deepseek-ai/dsh-mcp-client`, which connects to stdio and
Streamable HTTP servers, registers their tools as `mcp__<server>__<tool>`,
handles timeouts/reconnect/tool-list refresh, and maps results into the normal
tool-call parts. The product's job is configuration, per-Project selection, and
a safe secret path.

- **Status**: accepted
- **Context**: researchers need literature, database, filesystem, and lab MCP
  tools in the agent. *Considered and rejected*: a service-owned MCP client plus
  thin runtime plugins — it duplicates a mature first-party bridge and would
  still need per-runtime tool registration. *Considered and rejected*: managing
  openclaw MCP servers from Science Studio — the gateway already owns its MCP
  inventory and exposes only per-session enable/disable. *Considered and
  rejected*: MCP server mode (external clients calling Science Studio) — a
  separate product surface with its own auth and tool schema; deferred.
- **Decisions**:
  - **dsh-only, client-only.** `RuntimeCapabilities.mcp` is `true` for dsh and
    `false` for openclaw. The catalog may be edited while another runtime is
    active; it takes effect when the service runs dsh.
  - **The catalog is deployment settings.** `settings.mcp.servers` holds
    `McpServerSettings` rows: a unique `id` (the tool namespace), `scope`
    (`global` or `project`), `projectId` for project rows, `enabled`,
    `transport`, the stdio command/args/env/cwd or the HTTP URL/headers, and an
    optional `toolCallTimeoutMs`. Credentials live here (0600 file), not in a
    Project Workspace: a workspace is agent-readable, movable, and often
    committed, while the settings file is already the deployment secret home.
  - **Project scope is logical, not a file.** A project row is filtered by the
    adapter against the Project it is serving; it is not stored under that
    Project. Consequently it does not travel with a copied Project directory —
    the accepted trade for keeping credentials out of the workspace.
  - **Rows are managed one at a time.** `/api/mcp/servers` GET/POST/PUT/DELETE
    (plus `POST /api/mcp/probe`) replace the generic settings PUT for this
    section: a whole-list replace would let one Project delete another
    Project's rows. Writes are local-or-manager gated; reads are
    principal-only. `GET` returns `envKeys`/`headerKeys`, never values; a patch
    omits a key to keep it, sends a string to replace it, or `null` to remove
    it. Deleting a Project removes its project rows best-effort.
  - **The dsh child gets only its slice.** The service serializes the enabled
    catalog into `SS_MCP_SECRET_CONFIG`; `dshLocalBinding` carries it; the
    adapter filters to global + the active Project's rows, writes one
    `@deepseek-ai/dsh-mcp-client` insert per server into a per-launch patch, and
    passes the same array (mapped to the plugin's `serverName` shape) in the
    child env. The patch's `config` is only
    `!!js JSON.parse(process.env.SS_MCP_SECRET_CONFIG)[i]`, so credentials never
    touch the patch file. The `SECRET` in the env name also keeps it out of the
    harness's scrubbed subprocess envs.
  - **A bad server is isolated.** `failOnStartupError` stays false: a broken
    server loses its tools and logs, but the agent starts. The official bridge
    owns reconnect and tool-list refresh.
  - **Test connection is a probe, not the live connection.** The service uses
    `@modelcontextprotocol/sdk` to connect to the current draft (reusing stored
    credentials when editing), list tools, and disconnect within 10 s. It runs
    under the same manager gate and never persists the draft. The probe's stdio
    env is the scrubbed service env plus the configured env, and its default
    cwd is the active Project/Worktree root.
  - **Trust boundary.** stdio MCP commands execute on the host, and the agent
    already has a shell; MCP credentials entering the dsh child are therefore
    within the agent's trust boundary. Do not configure tokens with more
    privilege than the agent should have. Hosted multi-tenant isolation via a
    sandbox/secret broker is deferred.
- **Non-goals (v1)**: MCP server mode, resources/prompts, sampling/elicitation,
  OAuth flows, MCP apps/widgets, per-tenant catalogs, and openclaw MCP
  management (gateway-owned).
- **Consequences**: adding a server is a settings change plus a service restart
  (the child is long-lived and per Project). Tool definitions cost tokens on
  every request, so the UI warns and the `enabled` flag is the off switch.
  `mcp__<server>__<tool>` names are normalized by the bridge, so the UI treats
  them as opaque labels rather than parsing the raw tool name.
