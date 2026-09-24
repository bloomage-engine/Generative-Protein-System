# transport-dsh child plugins (per-launch profile patches)

The dsh adapter drives a THIRD-PARTY harness: `@deepseek-ai/dsh-sdk-client`
spawns `dsh --profile sdk` as a child process speaking stdio JSON-RPC, pinned
exactly (docs/adr/0004). That wire has no command plane, no cancel and no
token-level stream, and the binary cannot be modified. Everything Science Studio
needs to add to the agent — project scaffold, scheduling, HPC, worktrees, the
command bridge — therefore rides this document's mechanism: **at adapter init,
write one small YAML patch per plugin, hand each to the child as `--patch`, and
let the harness's own cordis plugin loader pull the plugin module into its
process.**

## 1. The injection mechanism

A cordis plugin is a plain JS module exporting a fixed shape:

```ts
export const name = "science-studio-cron";                  // plugin id
export const inject = ["commands", "tools", "systemPrompt"]; // host services to receive
export function apply(ctx: CronHost, config) { ... }         // called on child boot
```

The harness resolves the `inject` names against its own service container and
calls `apply` with that view plus the `config` node from the patch. The adapter
generates those patches; `packages/transport-dsh/src/bridge.ts` is the factory
(`writeBridgePatch`, `writeProjectPatch`, `writeCronPatch`, `writeSubagentPatch`,
`writeHpcPatch`, `writeWorktreePatch`), all emitting the same shape:

```yaml
- insert:
    - id: science-studio-cron
      name: "file:///abs/path/to/dist/cron-plugin.js"
      config: {"project": {"id": …}, "root": "/abs/project/root"}
```

Deliberate details:

- **No YAML dependency.** The patch is string-built; every value goes through
  `JSON.stringify` (a JSON string/object is valid YAML), so nested config needs
  no serializer.
- **No path resolution against the profile.** The plugin `name` is a `file:`
  URL — a form `dsh-app-boot` documents as supported — pointing at a sibling of
  the adapter's own `dist/` (`new URL("./cron-plugin.js", import.meta.url)`).
  The plugin ships INSIDE `@science-studio/transport-dsh`; the user installs
  nothing.
- **Unique file names** (`cron-<8hex>.cordis.patch.yml`) so two adapters / two
  Projects sharing `bridgeDir` never overwrite each other.
- **The patch config is the whole parent↔child contract**: Project identity,
  workspace root, socket path, service URL. A plugin with no `project` in its
  config goes INERT on its first line — the same plugin file mounted into a
  `project-default` cold start simply does nothing.

## 2. Launch sequence (`adapter.ts` → `initialize()`)

One adapter — and one child — per `(Project, Worktree)` (docs/adr/0008). Init
derives the agent cwd from the Workspace seam (`toAgentPath("")`, i.e. the same
directory the Files panel lists), then writes patches best-effort; every failed
write is one stderr warning and a child that lacks just that surface:

| # | Plugin (`inject` verbs) | Mounted when | Gives the child |
| --- | --- | --- | --- |
| 1 | `bridge-plugin.ts` | always | UNIX-socket bridge + cold-command interception (§4) |
| 2 | `subagent-plugin.ts` | always | one systemPrompt section: report each delegated subagent's result as it arrives (docs/adr/0018) |
| 3 | `project-plugin.ts` | real Project | research layout + `PROJECT.md` Brief, `project_update`/`project_log`, `/project` (docs/adr/0012; see docs/project-plugin.md) |
| 4 | `cron-plugin.ts` | real Project | `schedule_*` tools, `/cron`, prompt section — root pinned to MAIN (docs/adr/0017; see docs/cron-scheduled-runs.md) |
| 5 | `hpc-plugin.ts` | real Project | five `hpc_*` tools, fetch-only (docs/adr/0024) |
| 6 | `worktree-plugin.ts` | real Project | `worktree_*` tools, `/worktree`, fetch-only (docs/adr/0025) |

The collected paths go to `createClient({ patches })`, which passes each to the
SDK as `--patch <abs path>` (`resolveDshLaunch`).

## 3. The shared discipline (every plugin obeys it)

Each rule below corresponds to a real failure mode:

| Rule | Why |
| --- | --- |
| Import NOTHING from `@deepseek-ai/*` or cordis | The child owns its own pinned copies; importing them drags in a second copy or crashes on a harness bump. Host services are declared as LOCAL STRUCTURAL views (`CronHost`, `BridgeHost`, …); interface drift surfaces as a failed registration ("unavailable"), not a dead child. |
| Never write to stdout | The child's stdout IS the newline-delimited JSON-RPC wire. All diagnostics go to `process.stderr.write("[ss-…] …")`. |
| `apply` never throws (fail SOFT) | A throwing cordis plugin fails the ENTIRE child boot — the adapter would lose its whole runtime. Missing config → disabled; each registration wrapped in its own try. |
| Dispose through `ctx.effect(disposer, label)` | Lets cordis own lifecycle ordering (socket close, listener removal). |
| May import own-workspace packages (e.g. `@science-studio/cron`) | Resolved from the plugin file's physical location (the adapter's dist), so these never touch the harness's copies. |

What a plugin may register on the host: `ctx.tools.register(...)` (model-visible
tools with JSON-Schema parameters), `ctx.commands.register(...)` (harness slash
commands), `ctx.systemPrompt.section(...)` (a manual teaching the model when and
how to use them).

## 4. The bridge plugin: a second channel back

`bridge-plugin.ts` is the mechanism pushed to its deepest point — it does not
just register things, it opens a private channel (docs/adr/0010, 0011, 0022).
Its launch config carries a socket path, unique per adapter init
(`<pid>-<8hex>.sock`, deliberately SHORT: POSIX `sun_path` is 104–108 bytes and
a full UUID under macOS's long tmpdir makes `listen()` fail ENAMETOOLONG — a
silently bridge-less runtime). Owner-mode 0600, stale file `rmSync`ed first.
The adapter-side half (`createCommandBridge` in `bridge.ts`) speaks plain HTTP
over the socket path with fixed timeouts:

| Verb | Purpose | Budget |
| --- | --- | --- |
| `GET /commands` | the agent-scoped registry listing | 10 s |
| `POST /execute {sessionId, line}` | run one command line (a `/compact` runs a real model turn) | 300 s |
| `POST /interrupt {sessionId}` | `agent.cancel({kind:"user"},{keepInbox:true})` — the SDK wire has no cancel; this is the ONLY mid-turn stop | 10 s |
| `GET /assistant-stream` | long-lived NDJSON of the process-local `agent/assistant-stream` frames (`start`/`chunk`/`end`) — this is what makes token-level streaming + streamed tool calls possible (docs/adr/0022); the adapter reconnects every second while wanted | ∞ |

**The cold-session trick.** The registry is AGENT-scoped, and the only
agent-creating verb on the wire is a prompt. So when a session has no agent yet
and the user issues `/plan`, the adapter sends the line as that session's FIRST
PROMPT; the plugin's `agent/pre-step` waterfall listener sees "every user
prompt in this step is a command line", runs them through the harness's own
`commands.execute`, and returns `{kind:"reject"}` — the step ends `blocked` and
**the model never sees the line**. That is why plan mode / a goal can be in
force before the first model request. A catalog request never starts the child;
a user-issued command does.

## 5. Two authoring postures, one mechanism

Within the same patch mechanism the plugins take different power postures:

- **Files** (`project`, `cron`): the plugin reads/writes the Project Workspace
  directly, because a shared file is the authority and no IPC is needed.
- **Service proxy** (`hpc`, `worktree`): every tool `execute` is just a
  `fetch` of `/api/hpc/*` or `/api/worktrees*` — the service owns SSH and git,
  the plugin owns neither, and the systemPrompt explicitly forbids the agent
  from assuming otherwise (the worktree plugin cannot move the agent's cwd).
- **Behavior only** (`subagent`, the prompt half of `bridge`): no tools, just
  steering.

## 6. Not to be confused with

`packages/plugins/molql-tool-dsh` is also a dsh plugin, but an
**agent-side deployable**: built separately, installed into the harness's own
plugin/skill channels, not injected through a per-launch patch. The six
plugins in this document ship inside `@science-studio/transport-dsh` and need
no user installation.

## Verification

`packages/transport-dsh/test/`: `{bridge,project,cron,hpc,worktree,subagent}-plugin.test.ts`
(each plugin against a scripted host),
`{cron,project,hpc,worktree}-launch.test.ts` and `launch-cwd.test.ts` (the patch
files and the root pinning), `cron-main-root.test.ts`, plus
`services/transport-service/test/injected-plugins.test.ts`. The live child boot
is smoke-tested by `scripts/smoke-dsh-command-bridge.mjs` / `scripts/smoke-dsh.mjs`.
