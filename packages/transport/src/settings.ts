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

export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents?: SubagentSettings;
  thread?: ThreadSettings;
  hpc?: HpcSettings;
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
