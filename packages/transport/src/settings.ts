/**
 * The deployment settings contract (docs/superpowers/specs/2026-09-16-workbench-settings-dialog-design.md).
 *
 * These are the provisioned launch facts for the ACTIVE runtime, not record
 * rows: the service persists them and folds them over the launch env before a
 * binding is built. `plugins`/`agent` are reserved sections (v1 renders empty
 * states); their shape is intentionally opaque so a future plugin inventory or
 * agent capability can land without a seam change.
 */
export interface ModelSettings {
  /** The runtime's provider route id (dsh: `llm-pi-ai.providers.<provider>`). */
  provider?: string;
  /** The model id on that route. */
  model?: string;
  /** The route's base URL. */
  endpoint?: string;
  /** The route's credential value. WRITE-ONLY: never present in a response. */
  apiKey?: string;
}

export interface SubagentSettings {
  /** How long a finished subagent stays in the default (non-history) view, in hours. */
  visibleWindowHours?: number;
}

export interface ThreadSettings {
  /** Number of messages to show by default in the conversation view. */
  visibleMessageCount?: number;
}

/**
 * ONE HPC Endpoint (docs/adr/0024): a configured remote compute system the
 * service may submit Compute Jobs to over SSH. The credential is a key-file
 * PATH — deployment-scoped like the model route's `apiKeyEnv`, never secret
 * material, so it is safe to show in the settings view.
 */
export interface HpcEndpointSettings {
  /** The endpoint id — stable, `[a-z0-9][a-z0-9-]{0,63}` (the cron id grammar); names a Project Binding. */
  id: string;
  name: string;
  kind: "slurm" | "linux";
  /** Host, IP, or the operator's `~/.ssh/config` alias. */
  host: string;
  /** Absent = the SSH client decides (config / local user). */
  user?: string;
  /** Absent = 22. */
  port?: number;
  /** Path to the private key file (NOT the key material). Absent = ssh-agent/config. */
  keyPath?: string;
  /** slurm: the default partition submits fall back to. */
  defaultPartition?: string;
  /** A submit-time default wall time (`HH:MM:SS` or minutes), if the binding gives none. */
  defaultTime?: string;
  /** The runaway guard: 0/absent = unlimited. */
  maxConcurrentJobs?: number;
}

export interface HpcSettings {
  endpoints: HpcEndpointSettings[];
}

/** A deployment MCP server is global or bound to one Project. */
export type McpScope = "global" | "project";

/**
 * ONE deployment MCP server (docs/adr/0026). `env`/`headers` hold credentials
 * and are WRITE-ONLY: the settings view never returns their values.
 */
export interface McpServerSettings {
  /** Stable namespace and tool prefix (`mcp__<id>__<tool>`), unique across the catalog. */
  id: string;
  scope: McpScope;
  /** Required when `scope` is `"project"`. */
  projectId?: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http";
  /** stdio: executable (no shell interpolation). */
  command?: string;
  /** stdio: arguments. */
  args?: string[];
  /** stdio: explicit credentials/env, merged over the scrubbed ambient env. */
  env?: Record<string, string>;
  /** stdio: working directory; absent = the agent's worktree root. */
  cwd?: string;
  /** Streamable HTTP: endpoint URL. */
  url?: string;
  /** Streamable HTTP: request headers (credentials). */
  headers?: Record<string, string>;
  /** Per `tools/call` timeout; default 60000 ms. */
  toolCallTimeoutMs?: number;
}

export interface McpSettings {
  servers: McpServerSettings[];
}

/** The `GET` projection: keys stay visible, credential values never do. */
export interface McpServerView {
  id: string;
  scope: McpScope;
  projectId?: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  toolCallTimeoutMs?: number;
  envKeys: string[];
  headerKeys: string[];
}

/** A create/update body: omitted secret keys keep their stored value, `null` removes one. */
export interface McpServerDraft {
  id?: string;
  scope?: McpScope;
  projectId?: string;
  enabled?: boolean;
  transport?: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string | null> | null;
  cwd?: string;
  url?: string;
  headers?: Record<string, string | null> | null;
  toolCallTimeoutMs?: number;
}

export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents?: SubagentSettings;
  thread?: ThreadSettings;
  hpc?: HpcSettings;
  mcp?: McpSettings;
}

/** The `GET`/`PUT` response: `apiKey` is replaced by a configured flag. */
export interface RuntimeSettingsView {
  model: Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents: SubagentSettings;
  thread: ThreadSettings;
  /** Endpoints carry no secret material (a key is referenced by PATH), so the view shows them as-is. */
  hpc: HpcSettings;
  /** The active runtime product (`TRANSPORT_RUNTIME`). */
  runtime: string;
  /** The settings file the service read/wrote, for diagnosis. */
  settingsPath: string;
}

/** A `PUT` body's model section: absent = keep, `null` = clear, string = replace. */
export interface ModelSettingsPatch {
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string | null;
}

export interface SubagentSettingsPatch {
  visibleWindowHours?: number | null;
}

export interface ThreadSettingsPatch {
  visibleMessageCount?: number | null;
}

/** The `PUT` body's hpc section: `null` clears the whole list; an array replaces it. */
export interface HpcSettingsPatch {
  endpoints?: HpcEndpointSettings[] | null;
}

export interface RuntimeSettingsPatch {
  model?: ModelSettingsPatch;
  plugins?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  subagents?: SubagentSettingsPatch;
  thread?: ThreadSettingsPatch;
  hpc?: HpcSettingsPatch;
}
