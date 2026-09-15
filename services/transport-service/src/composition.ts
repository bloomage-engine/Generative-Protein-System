/**
 * The composition root: the ONE place that knows the deployment mode.
 *
 * Single-user (default): a local principal resolver, a per-Project local
 * environment, no enterprise code. Hosted: the private enterprise module named by
 * `SS_ENTERPRISE_MODULE` supplies the same `Backend` shape (bearer principal,
 * fleet sandboxes, tenant-scoped store). Nothing downstream branches on mode.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInMemoryRecordStore,
  createJsonlRecordStore,
  type Id,
  type RecordStore,
} from "@science-studio/record";
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
import { DEFAULT_RECORD_DEFAULTS, type RecordDefaults } from "./directory.js";

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
   * The authoritative record store. Project/Session identity and the Run rollup
   * come from here (the enterprise module supplies a tenant-scoped one).
   * Defaults to a fresh in-memory store, which is only useful in tests.
   */
  records?: RecordStore;
  /** The default Project and Agent a Session is filed under when unspecified. */
  recordDefaults?: RecordDefaults;
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
 * The single-user workspace for ONE Project: an `FsWorkspace` rooted at
 * `<PROJECT_ROOT>/<projectId>/` (agent side `<PROJECT_AGENT_ROOT>/<projectId>/`),
 * or a `NullWorkspace` when no `PROJECT_ROOT` is configured. Callers see one seam
 * either way, which is what lets the multi-user module swap in a cell's
 * bind-mount without touching them.
 */
export function localWorkspace(env: NodeJS.ProcessEnv, projectId: Id): Workspace {
  const root = env.PROJECT_ROOT;
  if (!root) return new NullWorkspace();
  const agentRoot = env.PROJECT_AGENT_ROOT ?? root;
  const maxInlineRaw = env.WORKSPACE_MAX_INLINE_BYTES;
  const maxInlineBytes = maxInlineRaw && /^\d+$/.test(maxInlineRaw) ? Number(maxInlineRaw) : undefined;
  return new FsWorkspace(join(root, projectId), {
    agentRoot: join(agentRoot, projectId),
    ...(maxInlineBytes !== undefined ? { maxInlineBytes } : {}),
  });
}

/**
 * The record store the single-user service uses: the dependency-free JSONL store
 * at `RECORD_STORE_PATH` (default `$XDG_DATA_HOME/science-studio/record.jsonl`),
 * or an in-memory one when `RECORD_STORE=memory` (tests/examples).
 */
export async function localRecordStore(env: NodeJS.ProcessEnv): Promise<RecordStore> {
  if (env.RECORD_STORE === "memory") return createInMemoryRecordStore();
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return createJsonlRecordStore(env.RECORD_STORE_PATH ?? join(base, "science-studio", "record.jsonl"));
}

/** Narrow the authoritative record store to the runtime-agnostic adapter seam. */
export function toRecordStoreLike(store: RecordStore): RecordStoreLike {
  return {
    addRun: async (run) => {
      await store.addRun(run);
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
  // One authoritative store: the adapter persists Runs through the narrowed view
  // of it, and the service resolves Project/Session identity from it.
  const records = await localRecordStore(env);
  const recordDefaults: RecordDefaults = {
    projectId: env.PROJECT_ID ?? DEFAULT_RECORD_DEFAULTS.projectId,
    projectName: env.PROJECT_NAME ?? DEFAULT_RECORD_DEFAULTS.projectName,
    agentId: env.AGENT_ID ?? DEFAULT_RECORD_DEFAULTS.agentId,
  };
  // A configured root must "just work": ensure the default Project exists.
  if (!(await records.getProject(recordDefaults.projectId))) {
    await records.createProject({
      id: recordDefaults.projectId,
      name: recordDefaults.projectName,
      createdAt: new Date().toISOString(),
    });
  }

  // One environment per Project, built lazily by the provider below: an
  // adapter's workspace-derived launch surface is fixed at `init` (for dsh the
  // harness child's cwd IS `workspace.toAgentPath("")`, and both runtimes map a
  // workspace attachment through the same object), so a shared adapter could
  // only ever serve ONE Project's directory — the default Project's — and every
  // other Project would run in the wrong place. A Project's Sessions share the
  // adapter built for it (and, for dsh, one harness child with that cwd).
  const recordStore = toRecordStoreLike(records);
  const environments = new LocalEnvironmentProvider({
    environmentFor: async (projectId) => {
      const workspace = localWorkspace(env, projectId);
      const adapter = plugin.factory.create(binding);
      // Init runs in the BACKGROUND, exactly like the pre-seam service: a slow
      // or unreachable runtime must not delay the request that first names the
      // Project. Every adapter's own entry points WAIT for it (openclaw on its
      // gateway handshake, dsh on the initialization it completes last — see
      // `awaitInit`), so a request arriving during init waits rather than fails.
      void adapter
        .init({ binding, recordStore, workspace, env: { ...env } })
        .catch((err) =>
          console.error(
            `[transport-service] adapter init failed for project "${projectId}"`,
            err,
          ),
        );
      return { adapter, workspace };
    },
  });

  return {
    principal: new LocalPrincipalResolver(),
    environments,
    cors: { origin: true },
    records,
    recordDefaults,
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
