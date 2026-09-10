/**
 * The environment seam: what a principal's session gets — a runtime binding and
 * a file root.
 *
 * This is the central deep module of the deployment story. Callers (the HTTP
 * route handlers) ask `acquire(principal, sessionKey)`; behind it sit
 * tenant->sandbox lookup, sandbox provisioning, adapter construction via a
 * runtime factory, connection caching/eviction, tenant-scoped record store
 * wiring, and workspace-root resolution.
 *
 * Single-user ships `LocalEnvironmentProvider` (one adapter, one root). The
 * hosted implementation (private enterprise module) composes a fleet sandbox
 * provider with a caching lifecycle.
 */
import type { Principal } from "./principal.js";
import type { RuntimeAdapter } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface Environment {
  readonly adapter: RuntimeAdapter;
  readonly workspace: Workspace;
  /**
   * The canonical session key the adapter resolved for the requested threadId.
   * Resolving it here (not in the route handler) keeps each runtime's session
   * namespace out of the runtime-agnostic service.
   */
  readonly sessionKey: string;
}

export interface EnvironmentProvider {
  /**
   * Get or lazily build the environment for a principal's session. `threadId`
   * is the raw client claim (`null` for the mount probe); the provider maps it
   * through the selected adapter's `resolveSessionKey`.
   */
  acquire(principal: Principal, threadId: string | null): Promise<Environment>;
  /** Tear down (logout, tenant deletion, deployment shutdown). */
  dispose(principal: Principal): Promise<void>;
}

/**
 * Single-user: one already-constructed adapter + workspace, shared by every
 * request. No provisioning, no caching, no per-tenant routing — and deliberately
 * no auth, which is what "single-user is login-free" means.
 */
export class LocalEnvironmentProvider implements EnvironmentProvider {
  constructor(private readonly environment: Omit<Environment, "sessionKey">) {}

  async acquire(_principal: Principal, threadId: string | null): Promise<Environment> {
    const claimed = typeof threadId === "string" && threadId.length > 0 ? threadId : null;
    const adapter = this.environment.adapter;
    const sessionKey =
      typeof adapter.resolveSessionKey === "function"
        ? adapter.resolveSessionKey(claimed)
        : (claimed ?? "default");
    return { ...this.environment, sessionKey };
  }

  async dispose(_principal: Principal): Promise<void> {
    /* nothing to tear down in single-user mode */
  }
}
