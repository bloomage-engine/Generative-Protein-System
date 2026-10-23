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
  DEFAULT_WORKTREE_ID,
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
  WorkspacePathError,
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
import { isSafeProjectId, WORKTREES_DIR, worktreeRelPath } from "./worktree/paths.js";
import { applySettingsToEnv, loadSettings, resolveSettingsPath } from "./settings.js";

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
  /** The deployment settings file the `/api/settings` routes read and write. */
  settingsPath?: string;
  /**
   * Test seam: replace the SSH runner the HPC surface uses (docs/adr/0024).
   * Absent = the real system-OpenSSH spawner.
   */
  hpcSsh?: import("./hpc/ssh.js").SshRunner;
  /** Test seam: the host-side project root git worktrees live under (default `PROJECT_ROOT`). */
  projectRoot?: string;
  /** Test seam: the git runner (defaults to the real system-git spawner). */
  git?: import("./worktree/git.js").GitRunner;
  /** Test seam: the MCP connectivity probe (defaults to the real SDK probe). */
  mcpProbe?: import("./mcp/probe.js").McpProber;
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
 * The single-user workspace for ONE Project's Worktree: an `FsWorkspace` rooted
 * at `<PROJECT_ROOT>/<projectId>/` for `main` (the Project root) or
 * `<PROJECT_ROOT>/<projectId>/.worktrees/<worktreeId>/` for a linked worktree
 * (agent side likewise under `PROJECT_AGENT_ROOT`), or a `NullWorkspace` when no
 * `PROJECT_ROOT` is configured. Callers see one seam either way, which is what
 * lets the multi-user module swap in a cell's bind-mount without touching them.
 */
export function localWorkspace(env: NodeJS.ProcessEnv, projectId: Id, worktreeId: Id): Workspace {
  // Belt-and-braces: `project-scope` already rejects an unsafe claim with a 400,
  // but this is the ONE place that joins the id into a filesystem path, so a
  // future caller that bypasses the scope can never read/write outside the root.
  if (!isSafeProjectId(projectId)) {
    throw new WorkspacePathError(`unsafe project id: ${projectId}`);
  }
  const root = env.PROJECT_ROOT;
  if (!root) return new NullWorkspace();
  const agentRoot = env.PROJECT_AGENT_ROOT ?? root;
  const maxInlineRaw = env.WORKSPACE_MAX_INLINE_BYTES;
  const maxInlineBytes = maxInlineRaw && /^\d+$/.test(maxInlineRaw) ? Number(maxInlineRaw) : undefined;
  const rel = worktreeRelPath(worktreeId);
  return new FsWorkspace(join(root, projectId, rel), {
    agentRoot: join(agentRoot, projectId, rel),
    hiddenEntries: [".git", WORKTREES_DIR],
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

/**
 * Narrow the authoritative record store to the runtime-agnostic adapter seam.
 * The view FORWARDS the record's durable extensions — the session transcript and
 * the subagent rows (docs/adr/0019) — as well as `addRun`: the dsh adapter owns
 * their shape and writes/reads them through THIS view, so dropping them here
 * makes every turn ephemeral (the "messages lost after restart" bug).
 */
export function toRecordStoreLike(store: RecordStore): RecordStoreLike {
  return {
    addRun: async (run) => {
      await store.addRun(run);
    },
    saveSessionTranscript: (sessionId, doc) => store.saveSessionTranscript(sessionId, doc),
    loadSessionTranscript: (sessionId) => store.loadSessionTranscript(sessionId),
    upsertSubagent: (subagent) => store.upsertSubagent(subagent),
    loadSubagent: (id) => store.loadSubagent(id),
    listSubagents: (parentSessionId) => store.listSubagents(parentSessionId),
  };
}

/**
 * Resolve the backend: the enterprise module when configured, otherwise the
 * complete single-user default. Returning here (and only here) is what makes
 * "single-user is unaffected by the absence of multi-user" true.
 */
export async function createBackend(
  env: NodeJS.ProcessEnv = process.env,
  plugins?: readonly RuntimePlugin[],
): Promise<Backend> {
  const specifier = env.SS_ENTERPRISE_MODULE;
  if (specifier) {
    const mod = (await import(specifier)) as EnterpriseModule;
    return mod.createBackend(env);
  }
  return localBackend(env, plugins);
}

async function localBackend(
  env: NodeJS.ProcessEnv,
  preloaded?: readonly RuntimePlugin[],
): Promise<Backend> {
  const plugins = preloaded && preloaded.length > 0 ? [...preloaded] : await resolveRuntimePlugins(env);

  const runtime = env.TRANSPORT_RUNTIME ?? DEFAULT_RUNTIME;
  const plugin = plugins.find((p) => p.runtime === runtime);
  if (!plugin) {
    const known = plugins.map((p) => p.runtime).join(", ") || "none";
    throw new Error(`no runtime plugin registered for "${runtime}" (available: ${known})`);
  }

  const settingsPath = env.SS_SETTINGS_PATH ?? resolveSettingsPath(env);
  const settings = await loadSettings(settingsPath);
  const runtimeEnv = applySettingsToEnv(env, settings);
  const binding = plugin.localBinding(runtimeEnv);
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

  // One environment per Project WORKTREE, built lazily by the provider below:
  // an adapter's workspace-derived launch surface is fixed at `init` (for dsh
  // the harness child's cwd IS `workspace.toAgentPath("")`, and both runtimes map
  // a workspace attachment through the same object), so a shared adapter could
  // only ever serve ONE directory — the default Project's main worktree — and
  // every other worktree would run in the wrong place (docs/adr/0008, 0025). A
  // worktree's Sessions share the adapter built for it (and, for dsh, one
  // harness child with that cwd).
  const recordStore = toRecordStoreLike(records);
  const environments = new LocalEnvironmentProvider({
    environmentFor: async (projectId, worktreeId) => {
      const workspace = localWorkspace(env, projectId, worktreeId);
      const adapter = plugin.factory.create(binding);
      // The record owns Project identity; the adapter gets a read-only copy so a
      // dsh child can render it into the Project Brief (docs/adr/0012). A
      // Project with no row (an arbitrary session key's first use) simply has
      // none. This lookup is cheap; the runtime launch below is not.
      const project = await records.getProject(projectId).catch(() => null);
      // The record likewise owns the Worktree identity; the adapter renders it
      // into the worktree plugin's system prompt (docs/adr/0025). An environment
      // is only acquired for a worktree the record validated, but a store
      // without the row (or a NullWorkspace test double) still initializes.
      const worktree = await records.getWorktree(projectId, worktreeId).catch(() => null);
      // The Project's `main` root, as the agent sees it. Scheduled runs are
      // MAIN-only (docs/adr/0025), so the dsh child's cron plugin is pointed here
      // regardless of which worktree the child runs in; an empty answer (a
      // NullWorkspace deployment) is not a path, so it is omitted and the
      // adapter falls back to its own cwd.
      const projectRoot = localWorkspace(env, projectId, DEFAULT_WORKTREE_ID).toAgentPath("");
      // Init runs in the BACKGROUND, exactly like the pre-seam service: a slow
      // or unreachable runtime must not delay the request that first names the
      // Project. Every adapter's own entry points WAIT for it (openclaw on its
      // gateway handshake, dsh on the initialization it completes last — see
      // `awaitInit`), so a request arriving during init waits rather than fails.
      void adapter
        .init({
          binding,
          recordStore,
          workspace,
          // The generic adapter env is the ORIGINAL launch env: a runtime's
          // credential reaches it through its own binding (dsh: `DshBinding`),
          // so the plaintext key must not ride along in a broadly-read object.
          env: { ...env },
          ...(project === null
            ? {}
            : { project: { id: project.id, name: project.name, createdAt: project.createdAt } }),
          ...(worktree === null
            ? {}
            : {
                worktree: {
                  id: worktree.id,
                  name: worktree.name,
                  branch: worktree.branch,
                  root: workspace.toAgentPath(""),
                },
              }),
          ...(projectRoot ? { projectRoot } : {}),
        })
        .catch((err) =>
          console.error(
            `[transport-service] adapter init failed for project "${projectId}" worktree "${worktreeId}"`,
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
    settingsPath,
  };
}

/** A positive integer from an env var, or undefined when unset/malformed. */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}
