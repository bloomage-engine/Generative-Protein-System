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

export interface RuntimeSettings {
  model: ModelSettings;
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents?: SubagentSettings;
}

/** The `GET`/`PUT` response: `apiKey` is replaced by a configured flag. */
export interface RuntimeSettingsView {
  model: Omit<ModelSettings, "apiKey"> & { apiKeyConfigured: boolean };
  plugins: Record<string, unknown>;
  agent: Record<string, unknown>;
  subagents: SubagentSettings;
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

export interface RuntimeSettingsPatch {
  model?: ModelSettingsPatch;
  plugins?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  subagents?: SubagentSettingsPatch;
}
