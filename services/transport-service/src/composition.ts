/**
 * The composition root: the ONE place that knows the deployment mode.
 *
 * Single-user (default): a local principal resolver, one local environment, no
 * enterprise code. Hosted: the private enterprise module named by
 * `SS_ENTERPRISE_MODULE` supplies the same `Backend` shape (bearer principal,
 * fleet sandboxes, tenant-scoped store). Nothing downstream branches on mode.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInMemoryRecordStore, type Artifact, type ArtifactKind, type RecordStore } from "@science-studio/record";
import { FsWorkspace } from "@science-studio/workspace";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_QUOTA_BYTES,
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type EnvironmentProvider,
  type PrincipalResolver,
  type QuotaPolicy,
  type RecordStoreLike,
  type RuntimeCapabilities,
  type RuntimePlugin,
  type Workspace,
  type WorkspaceLimits,
} from "@science-studio/transport";
import { DEFAULT_SESSION_DEFAULTS, type SessionDefaults } from "./sessions.js";

export interface CorsConfig {
  /** `true` reflects any origin (loopback single-user); a string locks to it. */
  origin: boolean | string | string[];
  credentials?: boolean;
}

export interface Backend {
  principal: PrincipalResolver;
  environments: EnvironmentProvider;
  cors: CorsConfig;
  quota?: QuotaPolicy;
  /** Upload/quota caps for the workspace file service. */
  workspaceLimits?: WorkspaceLimits;
  /**
   * The authoritative record store. Session identity and Run attribution come
   * from here (the enterprise module supplies a tenant-scoped one). Defaults to
   * a fresh in-memory store, which is only useful in tests.
   */
  records?: RecordStore;
  /** Where a first-use Session/Study is filed when the record has none yet. */
  sessionDefaults?: SessionDefaults;
  /** Declared traits of the selected runtime (drives `/approve`, UI hints). */
  capabilities?: RuntimeCapabilities;
}

/** The out-of-tree contract a private enterprise module implements. */
export interface EnterpriseModule {
  createBackend(env: NodeJS.ProcessEnv): Promise<Backend>;
}

const DEFAULT_RUNTIME = "openclaw";

/**
 * The runtime modules the DEFAULT single-user install loads, read from this
 * service's own `package.json` (`scienceStudio.runtimeModules`). They are
 * imported DYNAMICALLY by specifier, so no core *code* names a runtime product
 * and adding one is a data change (docs/design/implementation-plan.md §5).
 * `SS_RUNTIME_MODULES` overrides the list entirely.
 */
export function defaultRuntimeModules(): string[] {
  try {
    // `src/../package.json` in dev (tsx) and `dist/../package.json` when built:
    // both resolve to the service root.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { scienceStudio?: { runtimeModules?: unknown } };
    const modules = pkg.scienceStudio?.runtimeModules;
    if (Array.isArray(modules) && modules.every((m) => typeof m === "string" && m.length > 0)) {
      return modules as string[];
    }
  } catch {
    // An unreadable/renamed package.json surfaces as "no runtime plugin
    // registered" from the caller, which names the actual remedy.
  }
  return [];
}

/** Resolve the configured runtime modules and load their plugins. */
export async function resolveRuntimePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimePlugin[]> {
  const modules = (env.SS_RUNTIME_MODULES ?? defaultRuntimeModules().join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return loadRuntimePlugins(modules);
}

/** Dynamically import each module and collect its `runtimePlugins` export. */
export async function loadRuntimePlugins(specifiers: readonly string[]): Promise<RuntimePlugin[]> {
  const plugins: RuntimePlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const mod = (await import(specifier)) as { runtimePlugins?: RuntimePlugin[] };
      if (Array.isArray(mod.runtimePlugins)) plugins.push(...mod.runtimePlugins);
    } catch (err) {
      console.error(`[transport-service] failed to load runtime module "${specifier}"`, err);
    }
  }
  return plugins;
}

/**
 * The single-user workspace: an `FsWorkspace` when a root is configured, and a
 * `NullWorkspace` otherwise. Both satisfy the same seam, which is what lets the
 * multi-user module swap in a cell's bind-mount later without touching callers.
 */
export function localWorkspace(env: NodeJS.ProcessEnv): Workspace {
  const root = env.WORKSPACE_ROOT;
  if (!root) return new NullWorkspace();
  const maxInlineRaw = env.WORKSPACE_MAX_INLINE_BYTES;
  const maxInlineBytes = maxInlineRaw && /^\d+$/.test(maxInlineRaw) ? Number(maxInlineRaw) : undefined;
  return new FsWorkspace(root, {
    agentRoot: env.WORKSPACE_AGENT_ROOT ?? root,
    ...(maxInlineBytes !== undefined ? { maxInlineBytes } : {}),
  });
}

/** Narrow the authoritative record store to the runtime-agnostic adapter seam. */
export function toRecordStoreLike(store: RecordStore): RecordStoreLike {
  return {
    addRun: async (run) => {
      await store.addRun(run);
    },
    addArtifact: async (input) => {
      const kind: ArtifactKind = (
        ["dataset", "figure", "report", "code", "model", "other"] as const
      ).includes(input.kind as ArtifactKind)
        ? (input.kind as ArtifactKind)
        : "other";
      const artifact: Artifact = {
        id: `art-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        runId: input.runId,
        name: input.name,
        kind,
        location: input.location,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      await store.addArtifact(artifact);
    },
  };
}

/**
 * Resolve the backend: the enterprise module when configured, otherwise the
 * complete single-user default. Returning here (and only here) is what makes
 * "single-user is unaffected by the absence of multi-user" true.
 */
export async function createBackend(env: NodeJS.ProcessEnv = process.env): Promise<Backend> {
  const specifier = env.SS_ENTERPRISE_MODULE;
  if (specifier) {
    const mod = (await import(specifier)) as EnterpriseModule;
    return mod.createBackend(env);
  }
  return localBackend(env);
}

async function localBackend(env: NodeJS.ProcessEnv): Promise<Backend> {
  const plugins = await resolveRuntimePlugins(env);

  const runtime = env.TRANSPORT_RUNTIME ?? DEFAULT_RUNTIME;
  const plugin = plugins.find((p) => p.runtime === runtime);
  if (!plugin) {
    const known = plugins.map((p) => p.runtime).join(", ") || "none";
    throw new Error(`no runtime plugin registered for "${runtime}" (available: ${known})`);
  }

  const binding = plugin.localBinding(env);
  const adapter = plugin.factory.create(binding);
  const workspace = localWorkspace(env);
  // One authoritative store: the adapter persists Runs through the narrowed
  // view of it, and the service resolves Session identity from it.
  const records = createInMemoryRecordStore();
  // Init runs in the BACKGROUND, exactly like the pre-seam service: a slow or
  // unreachable runtime must not delay startup. The adapter's own `run()` awaits
  // its readiness, so requests arriving during init wait rather than fail.
  void adapter
    .init({
      binding,
      recordStore: toRecordStoreLike(records),
      workspace,
      env: { ...env },
    })
    .catch((err) => console.error("[transport-service] adapter init failed", err));

  return {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({ adapter, workspace }),
    cors: { origin: true },
    records,
    sessionDefaults: {
      projectId: env.PROJECT_ID ?? DEFAULT_SESSION_DEFAULTS.projectId,
      studyId: env.STUDY_ID ?? DEFAULT_SESSION_DEFAULTS.studyId,
      agentBlueprintId: env.AGENT_BLUEPRINT_ID ?? DEFAULT_SESSION_DEFAULTS.agentBlueprintId,
    },
    workspaceLimits: {
      maxUploadBytes: positiveInt(env.WORKSPACE_MAX_UPLOAD_BYTES) ?? DEFAULT_MAX_UPLOAD_BYTES,
      quotaBytes: positiveInt(env.WORKSPACE_QUOTA_BYTES) ?? DEFAULT_QUOTA_BYTES,
    },
    capabilities: plugin.factory.capabilities,
  };
}

/** A positive integer from an env var, or undefined when unset/malformed. */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}
