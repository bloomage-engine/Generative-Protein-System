/**
 * The dsh runtime's OWN launch surface. NOT part of the shared seam: dsh is a
 * locally spawned harness child, not a url/token pair, and only this module
 * knows its shape.
 */
import {
  RuntimeBindingError,
  bindingOptionalString,
  type RuntimeBinding,
  type RuntimeCapabilities,
} from "@science-studio/transport";

/** The private config shape of a dsh `RuntimeBinding`. */
export interface DshBinding {
  /** Harness profile (default "sdk"). */
  profile?: string;
  /** Harness home directory (default: the harness default, ~/.dsh). */
  home?: string;
  /** The agent's working directory (default: process.cwd()). */
  workspace?: string;
  provider?: string;
  model?: string;
  /** The provider route's base URL (service settings; harness-route override). */
  endpoint?: string;
  /** The route's credential VALUE. Held only for this launch, never persisted. */
  apiKey?: string;
  maxTokens?: number;
  /** Where the adapter persists its own transcript mirror. */
  transcriptDir?: string;
  /** Canonical session for client thread ids the framework mints locally. */
  defaultSession?: string;
  /** Reference to the API key in a secret store (`apiKeyRef`, never the key). */
  apiKeyRef?: string;
}

/** Validate an opaque binding against the dsh shape, or throw. */
export function parseDshBinding(binding: RuntimeBinding): DshBinding {
  if (binding.runtime !== "dsh") {
    throw new RuntimeBindingError(binding.runtime, 'expected runtime "dsh"');
  }
  const maxTokens = binding.config["maxTokens"];
  return {
    profile: bindingOptionalString(binding, "profile"),
    home: bindingOptionalString(binding, "home"),
    workspace: bindingOptionalString(binding, "workspace"),
    provider: bindingOptionalString(binding, "provider"),
    model: bindingOptionalString(binding, "model"),
    endpoint: bindingOptionalString(binding, "endpoint"),
    apiKey: bindingOptionalString(binding, "apiKey"),
    maxTokens: typeof maxTokens === "number" && Number.isFinite(maxTokens) ? maxTokens : undefined,
    transcriptDir: bindingOptionalString(binding, "transcriptDir"),
    defaultSession: bindingOptionalString(binding, "defaultSession"),
    apiKeyRef: bindingOptionalString(binding, "apiKeyRef"),
  };
}

/** Build a dsh binding (used by the local composition and tests). */
export function dshBinding(config: Omit<DshBinding, never> = {}): RuntimeBinding {
  return { runtime: "dsh", config: { ...config } };
}

/**
 * Single-user binding from the deployment env — the `LocalSandboxProvider` role
 * for dsh, kept here so no core package names a `DSH_*` key.
 */
export function dshLocalBinding(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeBinding {
  const config: Record<string, unknown> = {};
  const copy = (key: keyof DshBinding, envKey: string): void => {
    const value = env[envKey];
    if (value) config[key] = value;
  };
  copy("profile", "DSH_PROFILE");
  copy("home", "DSH_HOME");
  copy("workspace", "DSH_WORKSPACE");
  copy("provider", "DSH_PROVIDER");
  copy("model", "DSH_MODEL");
  copy("endpoint", "SS_MODEL_ENDPOINT");
  copy("apiKey", "SS_MODEL_API_KEY");
  copy("transcriptDir", "DSH_TRANSCRIPT_DIR");
  copy("defaultSession", "DSH_DEFAULT_SESSION");
  const maxTokens = env["DSH_MAX_TOKENS"];
  if (maxTokens && /^\d+$/.test(maxTokens)) config["maxTokens"] = Number(maxTokens);
  return { runtime: "dsh", config };
}

export const DSH_CAPABILITIES: RuntimeCapabilities = {
  /** The adapter publishes a catalog of commands it answers itself (docs/adr/0010). */
  commandCatalog: true,
  remoteSettleWatch: true,
  /** Committed log events, not tokens: replies are step-granular. */
  tokenStreaming: false,
  /** No approval surface in the sdk profile (docs/adr/0004). */
  approvals: false,
  hostedSandbox: true,
  /** The adapter spawns the child and sets its cwd. */
  perSessionCwd: true,
  subagents: true,
  /** Flips to `true` once the adapter implements `subagentTranscript()` (Task 5). */
  subagentTranscript: false,
};
