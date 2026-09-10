/**
 * The identity seam: WHO is making a request.
 *
 * Deployment mode (`single-user` vs `hosted`) is answered here and NOWHERE else.
 * The single-user default grants a constant principal with no credential; the
 * hosted implementation (a private enterprise module) verifies a bearer token.
 * Nothing downstream — the service, the adapters, the UI — branches on mode.
 *
 * Interface in the seam package; implementations may live out of tree.
 */
import type { Id } from "@science-studio/record";

export type Role = "researcher" | "manager";

export interface Principal {
  /** Stable user id; a constant in single-user mode. */
  id: Id;
  /** Trust boundary that owns this principal's sandbox. Equals `id` locally. */
  tenant: string;
  displayName: string;
  roles: readonly Role[];
  /** True when the deployment grants this identity without a credential. */
  local: boolean;
}

/** The minimal request facts a resolver may read — keeps it framework-free. */
export interface RequestContext {
  headers: Readonly<Record<string, string | undefined>>;
  url: string;
}

export interface PrincipalResolver {
  /** Resolve the caller, or null to reject (the HTTP layer answers 401). */
  resolve(req: RequestContext): Promise<Principal | null>;
}

/** Single-user: the whole "login-free" requirement, in one constant. */
export class LocalPrincipalResolver implements PrincipalResolver {
  async resolve(_req: RequestContext): Promise<Principal> {
    return {
      id: "local",
      tenant: "local",
      displayName: "Local researcher",
      roles: ["researcher", "manager"],
      local: true,
    };
  }
}
