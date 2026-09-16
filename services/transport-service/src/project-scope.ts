/**
 * The request's Project scope — the one place a route learns which Project (and
 * which Session of it) it is serving.
 *
 * Every environment-acquiring route needs the same three things: the request's
 * Principal, its Project, and that Project's `Environment` (one adapter and one
 * Project Workspace per Project — docs/adr/0008). Written out per route that was
 * nine copies of one preamble, three spellings of the Project key and five
 * copies of one error mapping.
 *
 * The claim is read in ONE order — the query first, the body second, else the
 * default Project — so no route has its own dialect. The query wins over the
 * body for the reason the transport route documents: assistant-ui builds its own
 * send body and always puts a per-page local `__LOCALID_*` threadId in it, so a
 * body-first read would let the body shadow the Session the app selected in the
 * URL (the reply would then reconcile against a different transcript). `project`
 * is the older spelling of the Project claim and stays accepted.
 *
 * Resolving the record's Session lives here too: a claimed runtime session key
 * IS a Science Studio Session id (1:1, docs/adr/0007), and the key is mapped
 * through the Project's OWN adapter (`resolveSessionKey`) — never a fabricated
 * constant.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Id, Session } from "@science-studio/record";
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

/** The Project claim's keys, canonical first; both are read from query and body. */
const PROJECT_CLAIM_KEYS = ["projectId", "project"] as const;
/** The Session claim's keys (a runtime session key, 1:1 with the record id). */
const SESSION_CLAIM_KEYS = ["threadId"] as const;

/** What one request is scoped to: its Principal, Project, Session claim, Environment. */
export interface ProjectScope {
  readonly principal: Principal;
  /** The Project this request names, or the default Project when it names none. */
  readonly projectId: Id;
  /** The Session the client claimed, or `null` (the mount probe claims none). */
  readonly threadId: string | null;
  /** The Project's adapter + Project Workspace, built on first use. */
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
   * Acquire a NAMED Project's environment, ignoring the request's claim. For
   * routes that act on the Project in their path rather than a claim (e.g.
   * delete, which recycles its workspace — docs/adr/0014).
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

  const acquire = async (request: FastifyRequest): Promise<ProjectScope> => {
    const principal = request.principal!;
    const projectId = claim(request, PROJECT_CLAIM_KEYS) ?? defaultProjectId;
    return {
      principal,
      projectId,
      threadId: claim(request, SESSION_CLAIM_KEYS),
      environment: await environments.acquire(principal, projectId),
    };
  };

  return {
    acquire,

    async acquireProject(principal, projectId) {
      return {
        principal,
        projectId,
        threadId: null,
        environment: await environments.acquire(principal, projectId),
      };
    },

    async sessionOf(request) {
      const scope = await acquire(request);
      const sessionKey = canonicalSessionKey(scope.environment.adapter, scope.threadId);
      return { ...scope, session: await directory.resolveOrCreateSession(scope.projectId, sessionKey) };
    },

    async withWorkspace(request, reply, run) {
      try {
        return await run(await acquire(request));
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
