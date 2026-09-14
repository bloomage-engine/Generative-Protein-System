/**
 * The environment seam: what a Project gets — a runtime adapter and a file root.
 *
 * This is the central deep module of the deployment story. Callers (the HTTP
 * route handlers) resolve a Session first, then ask
 * `acquire(principal, session.projectId)`; behind it sit tenant->project lookup,
 * sandbox provisioning, adapter construction via a runtime factory, per-Project
 * connection caching/eviction, tenant-scoped record store wiring, and
 * workspace-root resolution.
 *
 * The environment is scoped to a **Project**, not a principal and not a Session:
 * a Project owns one Project Workspace and its Sessions share it (docs/adr/0006).
 *
 * Single-user ships `LocalEnvironmentProvider` (a per-Project builder supplied by
 * the composition root). The hosted implementation (private enterprise module)
 * composes a fleet sandbox provider with a caching lifecycle.
 */
import type { Id } from "@science-studio/record";
import type { Principal } from "./principal.js";
import type { RuntimeAdapter } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  /** The Project whose workspace and adapter this environment serves. */
  readonly projectId: Id;
}

export interface EnvironmentProvider {
  /**
   * Get or lazily build the environment for a Project. The caller has already
   * resolved the Session (threadId → sessionKey → Session record), because the
   * Session's `projectId` decides which environment to build.
   */
  acquire(principal: Principal, projectId: Id): Promise<Environment>;
  /** Tear down (logout, tenant deletion, deployment shutdown). */
  dispose(principal: Principal): Promise<void>;
}

/** How a single-user deployment builds one Project's adapter + workspace. */
export interface LocalEnvironmentOptions {
  /** Lazily build a Project's adapter and workspace (called at most once per Project). */
  environmentFor(projectId: Id): Promise<{ adapter: RuntimeAdapter; workspace: Workspace }>;
}

/**
 * Single-user: environments are built on demand per Project and cached, so a
 * Project's Sessions share one adapter (and, for dsh, one harness child whose cwd
 * is that Project's workspace). Deliberately no auth — single-user is login-free.
 */
export class LocalEnvironmentProvider implements EnvironmentProvider {
  private readonly environments = new Map<Id, Environment>();
  /** De-duplicate concurrent first uses of the same Project. */
  private readonly inflight = new Map<Id, Promise<Environment>>();

  constructor(private readonly local: LocalEnvironmentOptions) {}

  async acquire(_principal: Principal, projectId: Id): Promise<Environment> {
    const cached = this.environments.get(projectId);
    if (cached) return cached;

    let pending = this.inflight.get(projectId);
    if (!pending) {
      pending = this.local
        .environmentFor(projectId)
        .then((built) => {
          const environment: Environment = { ...built, projectId };
          this.environments.set(projectId, environment);
          return environment;
        })
        .finally(() => this.inflight.delete(projectId));
      this.inflight.set(projectId, pending);
    }
    return pending;
  }

  async dispose(_principal: Principal): Promise<void> {
    this.environments.clear();
  }
}
