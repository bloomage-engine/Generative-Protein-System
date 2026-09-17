/**
 * The runtime-plurality seam: HOW a concrete agent runtime plugs in.
 *
 * The shared seam never names a launch surface (`url`, `token`, a child handle,
 * an API key). A runtime package owns its own binding shape and exports a
 * factory; the composition root registers factories from configuration, so
 * `transport-service` carries no static import of a runtime package.
 *
 * Adding a runtime = adding a package + registering a factory. No core package
 * changes (enforced by CI, see docs/design/implementation-plan.md §5).
 */
import type { RuntimeAdapter } from "./types.js";

/**
 * Opaque connection material produced by a sandbox provider for ONE runtime.
 * `config`'s shape is private to the runtime's adapter and factory.
 */
export interface RuntimeBinding {
  readonly runtime: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Constructs (but does not `init()`) an adapter for one binding. Must be sync. */
export interface RuntimeFactory {
  readonly runtime: string;
  /** Declared traits of this runtime product (see `RuntimeCapabilities`). */
  readonly capabilities: RuntimeCapabilities;
  create(binding: RuntimeBinding): RuntimeAdapter;
}

/**
 * The single export a runtime package publishes so the composition root can use
 * it WITHOUT importing the package statically. Convention: a runtime module
 * exports `runtimePlugins: RuntimePlugin[]`; the service dynamically imports the
 * module specifiers named by configuration.
 */
export interface RuntimePlugin {
  readonly runtime: string;
  readonly factory: RuntimeFactory;
  /**
   * Build this runtime's single-user binding from the deployment env slice —
   * the `LocalSandboxProvider` role, kept in the runtime package so the core
   * never learns a launch surface.
   */
  localBinding(env: Readonly<Record<string, string | undefined>>): RuntimeBinding;
}

/**
 * Traits consumers must know UP FRONT (the service exposes `/approve` only when
 * `approvals`; the UI renders a token-streaming caret only when `tokenStreaming`;
 * the workspace policy partitions per session only when `perSessionCwd`).
 *
 * Keep this set small: a field earns its place only when a consumer would
 * otherwise hardcode the runtime's name.
 */
export interface RuntimeCapabilities {
  /** `RuntimeAdapter.listCommands()` is available. */
  commandCatalog: boolean;
  /** `RuntimeAdapter.subscribe()` is available (remote settles are observable). */
  remoteSettleWatch: boolean;
  /** Replies stream token-by-token; false means step-granular whole-message sets. */
  tokenStreaming: boolean;
  /** The runtime has an approval surface (`RuntimeAdapter.approve`). */
  approvals: boolean;
  /** The runtime can be provisioned server-side as a per-tenant sandbox. */
  hostedSandbox: boolean;
  /** The runtime can pin a session's working directory (dsh: true, openclaw: false). */
  perSessionCwd: boolean;
  /** `RuntimeAdapter.subagents()` is available (live subagent activity). */
  subagents: boolean;
}

/** Thrown when a binding does not match the runtime's expected shape. */
export class RuntimeBindingError extends Error {
  constructor(runtime: string, detail: string) {
    super(`invalid ${runtime} binding: ${detail}`);
    this.name = "RuntimeBindingError";
  }
}

/** Read a required string field from a binding's private config. */
export function bindingString(binding: RuntimeBinding, key: string): string {
  const value = binding.config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeBindingError(binding.runtime, `missing string field "${key}"`);
  }
  return value;
}

/** Read an optional string field from a binding's private config. */
export function bindingOptionalString(binding: RuntimeBinding, key: string): string | undefined {
  const value = binding.config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
