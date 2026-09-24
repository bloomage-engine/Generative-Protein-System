"use client";

/**
 * The Project / Session record surface.
 *
 * The app's picker is a thin client over the service's record routes
 * (`/api/projects*`), so Project/Session identity lives in the record layer and
 * never in the UI (docs/adr/0002, 0007). Plain fetch helpers — no React — so the
 * app can use them from a route page and they stay unit-testable.
 */
import type { Project, Run, Session } from "@science-studio/record";
import { scopedUrl, scopeBody, type ClientScope } from "./scope.js";

/** Re-exported so apps consume record shapes without depending on the package. */
export type { Project, Run, Session };

export const DEFAULT_PROJECTS_API = "/api/projects";

/** A record request that failed with an HTTP status. */
export class RecordRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecordRequestError";
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when there IS a body: Fastify rejects an
  // empty body that claims `application/json` (the archive/delete hops).
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    let message = `record request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new RecordRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

/**
 * A Project-scoped record path. The Project is a PATH segment here (never a
 * claim), so the scope carries no query; only the extra `params` ride along.
 */
function projectPath(api: string, projectId: string, path: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  return scopedUrl(api, `/${encodeURIComponent(projectId)}${path}`, { projectId: null }, params);
}

/** The Projects this install knows about (archived ones excluded). */
export async function fetchProjects(api: string = DEFAULT_PROJECTS_API): Promise<Project[]> {
  const body = await request<{ projects: Project[] }>(scopedUrl(api, "", { projectId: null }));
  return body.projects;
}

/**
 * The Project listing together with the bootstrap Project's id. The workbench
 * needs the latter to lock rename/archive/delete on the immutable default
 * (docs/adr/0014).
 */
export async function fetchProjectsOverview(
  api: string = DEFAULT_PROJECTS_API,
  opts: { includeArchived?: boolean } = {},
): Promise<{ projects: Project[]; defaultProjectId: string }> {
  return request<{ projects: Project[]; defaultProjectId: string }>(
    scopedUrl(api, "", { projectId: null }, { includeArchived: opts.includeArchived }),
  );
}

/** Create a Project; the service mints its id (a filesystem-safe slug). */
export async function createProject(api: string, name: string): Promise<Project> {
  const body = await request<{ project: Project }>(scopedUrl(api, "", { projectId: null }), {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.project;
}

/** Rename a Project; its id (and workspace directory) is immutable. */
export async function renameProject(api: string, projectId: string, name: string): Promise<Project> {
  const body = await request<{ project: Project }>(projectPath(api, projectId, "/rename"), {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.project;
}

/** Archive a Project — hidden from the default listing, restorable. */
export async function archiveProject(api: string, projectId: string): Promise<Project> {
  const body = await request<{ project: Project }>(projectPath(api, projectId, "/archive"), {
    method: "POST",
  });
  return body.project;
}

/** Clear a Project's archived flag. */
export async function unarchiveProject(api: string, projectId: string): Promise<Project> {
  const body = await request<{ project: Project }>(projectPath(api, projectId, "/unarchive"), {
    method: "POST",
  });
  return body.project;
}

/**
 * Delete a Project irreversibly: its record (and its Sessions' Runs) go, and the
 * service moves its workspace into a recycle bin. The UI offers no restore.
 */
export async function deleteProject(api: string, projectId: string): Promise<void> {
  await request<{ ok: true }>(projectPath(api, projectId, "/delete"), {
    method: "POST",
  });
}

/**
 * A Project's Sessions, in creation order. Archived sessions excluded by
 * default. The scope's Worktree filters to one Worktree's Sessions
 * (docs/adr/0025): a Session belongs to the checkout it was created under, so
 * the workbench lists them per worktree rather than Project-wide. The Project
 * is the path; only the Worktree claim rides the query.
 */
export async function fetchProjectSessions(
  api: string,
  scope: ClientScope,
  opts: { includeArchived?: boolean } = {},
): Promise<Session[]> {
  const body = await request<{ sessions: Session[] }>(
    scopedUrl(
      api,
      `/${encodeURIComponent(scope.projectId ?? "")}/sessions`,
      { projectId: null, worktreeId: scope.worktreeId },
      { includeArchived: opts.includeArchived },
    ),
  );
  return body.sessions;
}

/**
 * Create a Session under a Project (optionally under one of its Worktrees) and
 * return it (its id is the threadId). The service reads the Worktree claim from
 * the JSON body (`POST /api/projects/:id/sessions` — the Project is the path),
 * validates it against the record, and files the Session under it; an unknown
 * one is a 404, never a fabricated row.
 */
export async function createSession(
  api: string,
  scope: ClientScope,
  opts: { agentId?: string; title?: string } = {},
): Promise<Session> {
  const body = await request<{ session: Session }>(
    scopedUrl(api, `/${encodeURIComponent(scope.projectId ?? "")}/sessions`, { projectId: null }),
    {
      method: "POST",
      body: JSON.stringify({ ...scopeBody({ projectId: null, worktreeId: scope.worktreeId }), ...opts }),
    },
  );
  return body.session;
}

/** Rename a Session (its `title`). */
export async function renameSession(
  api: string,
  projectId: string,
  sessionId: string,
  title: string,
): Promise<Session> {
  const body = await request<{ session: Session }>(
    sessionPath(api, projectId, sessionId, "rename"),
    {
      method: "POST",
      body: JSON.stringify({ title }),
    },
  );
  return body.session;
}

/** Archive a Session — hidden from the default listing, restorable. */
export async function archiveSession(
  api: string,
  projectId: string,
  sessionId: string,
): Promise<Session> {
  const body = await request<{ session: Session }>(sessionPath(api, projectId, sessionId, "archive"), {
    method: "POST",
  });
  return body.session;
}

/** Clear a Session's archived flag. */
export async function unarchiveSession(
  api: string,
  projectId: string,
  sessionId: string,
): Promise<Session> {
  const body = await request<{ session: Session }>(
    sessionPath(api, projectId, sessionId, "unarchive"),
    { method: "POST" },
  );
  return body.session;
}

/** Delete a Session irreversibly: its record and its Runs go. */
export async function deleteSession(
  api: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  await request<{ ok: true }>(sessionPath(api, projectId, sessionId, "delete"), {
    method: "POST",
  });
}

function sessionPath(api: string, projectId: string, sessionId: string, action: string): string {
  return scopedUrl(
    api,
    `/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/${action}`,
    { projectId: null },
  );
}

/** A Project's Runs — the turns of all its Sessions (the result rollup). */
export async function fetchProjectRuns(api: string, projectId: string): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(projectPath(api, projectId, "/runs"));
  return body.runs;
}

/** The Runs of ONE Session (the status bar's metrics source). */
export async function fetchSessionRuns(
  api: string,
  scope: ClientScope,
  sessionId: string,
): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(
    scopedUrl(
      api,
      `/${encodeURIComponent(scope.projectId ?? "")}/runs`,
      { projectId: null },
      { sessionId },
    ),
  );
  return body.runs;
}
