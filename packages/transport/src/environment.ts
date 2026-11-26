/**
 * The environment seam: what a Project's Worktree gets — a runtime adapter and a
 * file root.
 *
 * This is the central deep module of the deployment story. Callers (the HTTP
 * route handlers) resolve a Session first, then ask
 * `acquire(principal, session.projectId, session.worktreeId)`; behind it sit
 * tenant->project lookup, sandbox provisioning, adapter construction via a
 * runtime factory, per-worktree connection caching/eviction, tenant-scoped
 * record store wiring, and workspace-root resolution.
 *
 * The environment is scoped to a **Project Worktree**, not a principal and not a
 * Session: a Project owns Worktrees, and the Sessions of one Worktree share its
 * workspace and adapter (docs/adr/0006, 0025).
 *
 * Single-user ships `LocalEnvironmentProvider` (a per-worktree builder supplied
 * by the composition root). The hosted implementation (private enterprise
 * module) composes a fleet sandbox provider with a caching lifecycle.
 */
import type { Id } from "@gps/record";
import type { Principal } from "./principal.js";
import type { RuntimeAdapter } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  /** The Project whose workspace and adapter this environment serves. */
  readonly projectId: Id;
  /**
   * The Worktree of that Project this environment serves (docs/adr/0025). One
   * adapter (and, for dsh, one harness child) per LIVE worktree, because an
   * adapter's workspace-derived launch surface is fixed at `init`.
   */
  readonly worktreeId: Id;
}

export interface EnvironmentProvider {
  /**
   * Get or lazily build the environment for a Project's Worktree. The caller has
   * already resolved the Session (threadId → sessionKey → Session record),
   * because the Session's `projectId`/`worktreeId` decide which environment to
   * build.
   */
  acquire(principal: Principal, projectId: Id, worktreeId: Id): Promise<Environment>;
  /**
   * Drop cached environment(s) — an adapter and workspace — e.g. after the
   * Project is deleted (docs/adr/0014) or one of its Worktrees is removed
   * (docs/adr/0025), so the runtime (for dsh, a harness child whose cwd was just
   * recycled) is torn down. With a `worktreeId` only that worktree's child is
   * dropped; omitted, every child of the Project is. Optional: a deployment that
   * does not cache per worktree can omit it. `dispose` remains the
   * whole-principal teardown.
   */
  release?(principal: Principal, projectId: Id, worktreeId?: Id): Promise<void>;
  /** Tear down (logout, tenant deletion, deployment shutdown). */
  dispose(principal: Principal): Promise<void>;
}

/** How a single-user deployment builds one worktree's adapter + workspace. */
export interface LocalEnvironmentOptions {
  /** Lazily build a worktree's adapter and workspace (called at most once per worktree). */
  environmentFor(
    projectId: Id,
    worktreeId: Id,
  ): Promise<{ adapter: RuntimeAdapter; workspace: Workspace }>;
}

/**
 * Single-user: environments are built on demand per worktree and cached, so a
 * worktree's Sessions share one adapter (and, for dsh, one harness child whose
 * cwd is that worktree's directory). Deliberately no auth — single-user is
 * login-free.
 */
export class LocalEnvironmentProvider implements EnvironmentProvider {
  private readonly environments = new Map<string, Environment>();
  /** De-duplicate concurrent first uses of the same worktree. */
  private readonly inflight = new Map<string, Promise<Environment>>();

  constructor(private readonly local: LocalEnvironmentOptions) {}

  private static key(projectId: Id, worktreeId: Id): string {
    return `${projectId}\u0000${worktreeId}`;
  }

  async acquire(_principal: Principal, projectId: Id, worktreeId: Id): Promise<Environment> {
    const key = LocalEnvironmentProvider.key(projectId, worktreeId);
    const cached = this.environments.get(key);
    if (cached) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.local
        .environmentFor(projectId, worktreeId)
        .then((built) => {
          const environment: Environment = { ...built, projectId, worktreeId };
          this.environments.set(key, environment);
          return environment;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  async release(_principal: Principal, projectId: Id, worktreeId?: Id): Promise<void> {
    const prefix = `${projectId}\u0000`;
    const matches = (key: string): boolean =>
      worktreeId === undefined
        ? key.startsWith(prefix)
        : key === LocalEnvironmentProvider.key(projectId, worktreeId);
    // Both maps: a key that is still BUILDING lives only in `inflight`, and
    // dropping only `environments` would let that build re-cache afterwards.
    const keys = new Set<string>(
      [...this.environments.keys(), ...this.inflight.keys()].filter(matches),
    );
    for (const key of keys) {
      this.environments.delete(key);
      const pending = this.inflight.get(key);
      if (pending) {
        await pending.catch(() => {});
        this.environments.delete(key);
      }
    }
  }

  async dispose(_principal: Principal): Promise<void> {
    this.environments.clear();
  }
}
