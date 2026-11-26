/**
 * The request's Project + Worktree scope — the one place a route learns which
 * Project (and which Worktree and Session of it) it is serving.
 *
 * Every environment-acquiring route needs the same three things: the request's
 * Principal, its Project, and that Project's Worktree `Environment` (one adapter
 * and one Project Workspace per worktree — docs/adr/0008, 0025). Written out per
 * route that was nine copies of one preamble, three spellings of the Project key
 * and five copies of one error mapping.
 *
 * The claim is read in ONE order — the query first, the body second, else the
 * default Project — so no route has its own dialect. The query wins over the
 * body for the reason the transport route documents: assistant-ui builds its own
 * send body and always puts a per-page local `__LOCALID_*` threadId in it, so a
 * body-first read would let the body shadow the Session the app selected in the
 * URL (the reply would then reconcile against a different transcript). `project`
 * is the older spelling of the Project claim and stays accepted, and an omitted
 * `worktreeId` claims the Project's `main` worktree.
 *
 * Resolving the record's Session lives here too: a claimed runtime session key
 * IS a Science Studio Session id (1:1, docs/adr/0007), and the key is mapped
 * through the Worktree's OWN adapter (`resolveSessionKey`) — never a fabricated
 * constant.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_WORKTREE_ID, type Id, type Session } from "@science-studio/record";
import {
  FileTooLargeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspaceUnavailableError,
  type Environment,
  type EnvironmentProvider,
  type Principal,
  type RuntimeAdapter,
} from "@science-studio/transport";
import type { RecordDirectory } from "./directory.js";
import { isSafeProjectId } from "./worktree/paths.js";

/** The Project claim's keys, canonical first; both are read from query and body. */
const PROJECT_CLAIM_KEYS = ["projectId", "project"] as const;
/** The Worktree claim's key (a Project root is the `main` worktree — docs/adr/0025). */
const WORKTREE_CLAIM_KEYS = ["worktreeId"] as const;
/** The Session claim's keys (a runtime session key, 1:1 with the record id). */
const SESSION_CLAIM_KEYS = ["threadId"] as const;

/** The ids one request resolves to, before any environment is acquired. */
export interface ProjectClaim {
  readonly principal: Principal;
  readonly projectId: Id;
  readonly worktreeId: Id;
  readonly threadId: string | null;
}

/** What one request is scoped to: its Principal, Project, Worktree, Session claim, Environment. */
export interface ProjectScope {
  readonly principal: Principal;
  /** The Project this request names, or the default Project when it names none. */
  readonly projectId: Id;
  /** The Worktree this request names, or the Project's `main` when it names none. */
  readonly worktreeId: Id;
  /** The Session the client claimed, or `null` (the mount probe claims none). */
  readonly threadId: string | null;
  /** The worktree's adapter + Project Workspace, built on first use. */
  readonly environment: Environment;
}

export interface ProjectScopeOptions {
  environments: EnvironmentProvider;
  directory: RecordDirectory;
  /** The Project a request that names none is filed under. */
  defaultProjectId: Id;
}

export interface ProjectScopes {
  /** The request's Principal, its Project and that Project's Environment. */
  acquire(request: FastifyRequest): Promise<ProjectScope>;
  /**
   * The request's ids WITHOUT acquiring an environment — for routes that need
   * only the claim (e.g. the Worktree list, which ensures `main` itself).
   */
  claim(request: FastifyRequest): Promise<ProjectClaim>;
  /**
   * Acquire a NAMED Project's environment, ignoring the request's claim. For
   * routes that act on the Project in their path rather than a claim (e.g.
   * delete, which recycles its workspace — docs/adr/0014). Resolves to the
   * Project's `main` worktree.
   */
  acquireProject(principal: Principal, projectId: Id): Promise<ProjectScope>;
  /**
   * `acquire`, plus the record's Session for the claimed threadId — found, or
   * first-use recorded under the Project (docs/adr/0007).
   */
  sessionOf(request: FastifyRequest): Promise<ProjectScope & { session: Session }>;
  /**
   * Run against the Project's Project Workspace, mapping the Workspace seam's
   * failures onto HTTP statuses. The acquire sits INSIDE that mapping, exactly
   * as it did when every file route wrote this out.
   */
  withWorkspace<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (scope: ProjectScope) => Promise<T>,
  ): Promise<T | FastifyReply>;
  /**
   * Like {@link withWorkspace}, but against an EXPLICIT Project instead of the
   * request's claim — for a route that resolves its Project from elsewhere
   * (e.g. the workspace file the user is currently viewing).
   */
  withWorkspaceFor<T>(
    request: FastifyRequest,
    projectId: Id,
    reply: FastifyReply,
    run: (scope: ProjectScope) => Promise<T>,
  ): Promise<T | FastifyReply>;
}

/**
 * The runtime's canonical session key for a client's thread claim: the adapter
 * maps it when it has a namespace of its own (openclaw's `agent:…`, dsh's
 * generation-scoped ids), else the claim itself, else the runtime's default.
 */
export function canonicalSessionKey(adapter: RuntimeAdapter, threadId: string | null): string {
  return typeof adapter.resolveSessionKey === "function"
    ? adapter.resolveSessionKey(threadId)
    : (threadId ?? "default");
}

export function createProjectScopes(opts: ProjectScopeOptions): ProjectScopes {
  const { environments, directory, defaultProjectId } = opts;

  /** First non-empty string among `keys`, the query before the body. */
  const claim = (request: FastifyRequest, keys: readonly string[]): string | null => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    // A non-JSON route's body is a stream, whose claim properties are undefined.
    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const source of [query, body]) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
    return null;
  };

  /**
   * Reject a Project id that is unsafe as ONE path segment (traversal, empty,
   * absolute) BEFORE any route joins it onto the workspace root or the record.
   * Thrown as a `WorkspacePathError` so it maps to 400 everywhere: the workspace
   * routes through `sendWorkspaceError`, the transport/other acquiring routes
   * through the server's error handler. A client-supplied `project=../../etc`
   * would otherwise escape `PROJECT_ROOT` (docs/adr/0025).
   */
  const requireSafeProjectId = (projectId: Id): Id => {
    if (!isSafeProjectId(projectId)) {
      throw new WorkspacePathError(`unsafe project id: ${projectId}`);
    }
    return projectId;
  };

  const resolveClaim = (request: FastifyRequest): ProjectClaim => {
    const principal = request.principal!;
    return {
      principal,
      projectId: requireSafeProjectId(claim(request, PROJECT_CLAIM_KEYS) ?? defaultProjectId),
      worktreeId: claim(request, WORKTREE_CLAIM_KEYS) ?? DEFAULT_WORKTREE_ID,
      threadId: claim(request, SESSION_CLAIM_KEYS),
    };
  };

  const acquire = async (request: FastifyRequest): Promise<ProjectScope> => {
    const resolved = resolveClaim(request);
    // `main` is auto-ensured (docs/adr/0025): a Project root is its `main`
    // worktree, so every worktree-touching path materializes the row first, and
    // `requireWorktree` then rejects only an unknown NON-main id — never an
    // implicit create.
    await directory.ensureWorktree(resolved.projectId);
    await directory.requireWorktree(resolved.projectId, resolved.worktreeId);
    return {
      ...resolved,
      environment: await environments.acquire(
        resolved.principal,
        resolved.projectId,
        resolved.worktreeId,
      ),
    };
  };

  const acquireProject = async (principal: Principal, projectId: Id): Promise<ProjectScope> => {
    // A NAMED Project in the request path is client-supplied too, and the
    // project path routes (delete) reach the workspace root through here.
    requireSafeProjectId(projectId);
    const worktreeId = DEFAULT_WORKTREE_ID;
    await directory.ensureWorktree(projectId);
    await directory.requireWorktree(projectId, worktreeId);
    return {
      principal,
      projectId,
      worktreeId,
      threadId: null,
      environment: await environments.acquire(principal, projectId, worktreeId),
    };
  };

  const withWorkspace = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (scope: ProjectScope) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await run(await acquire(request));
    } catch (err) {
      return sendWorkspaceError(reply, err);
    }
  };

  return {
    acquire,

    claim: async (request) => resolveClaim(request),

    acquireProject,
    withWorkspace,

    async sessionOf(request) {
      const scope = await acquire(request);
      const sessionKey = canonicalSessionKey(scope.environment.adapter, scope.threadId);
      return {
        ...scope,
        session: await directory.resolveOrCreateSession(
          scope.projectId,
          sessionKey,
          scope.worktreeId,
        ),
      };
    },

    async withWorkspaceFor(request, projectId, reply, run) {
      try {
        return await run(await acquireProject(request.principal!, projectId));
      } catch (err) {
        return sendWorkspaceError(reply, err);
      }
    },
  };
}

/** Map a workspace error onto an HTTP status; rethrow anything unrecognized. */
function sendWorkspaceError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof WorkspaceNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof FileTooLargeError) return reply.code(413).send({ error: err.message });
  if (err instanceof WorkspacePathError) return reply.code(400).send({ error: err.message });
  if (err instanceof WorkspaceUnavailableError) return reply.code(503).send({ error: err.message });
  throw err;
}
