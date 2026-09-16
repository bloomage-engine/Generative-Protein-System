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

function base(api: string): string {
  return api.replace(/\/+$/, "");
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

/** The Projects this install knows about (archived ones excluded). */
export async function fetchProjects(api: string = DEFAULT_PROJECTS_API): Promise<Project[]> {
  const body = await request<{ projects: Project[] }>(`${base(api)}`);
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
  const query = opts.includeArchived ? "?includeArchived=1" : "";
  return request<{ projects: Project[]; defaultProjectId: string }>(`${base(api)}${query}`);
}

/** Create a Project; the service mints its id (a filesystem-safe slug). */
export async function createProject(api: string, name: string): Promise<Project> {
  const body = await request<{ project: Project }>(`${base(api)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.project;
}

/** Rename a Project; its id (and workspace directory) is immutable. */
export async function renameProject(api: string, projectId: string, name: string): Promise<Project> {
  const body = await request<{ project: Project }>(
    `${base(api)}/${encodeURIComponent(projectId)}/rename`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return body.project;
}

/** Archive a Project — hidden from the default listing, restorable. */
export async function archiveProject(api: string, projectId: string): Promise<Project> {
  const body = await request<{ project: Project }>(
    `${base(api)}/${encodeURIComponent(projectId)}/archive`,
    { method: "POST" },
  );
  return body.project;
}

/** Clear a Project's archived flag. */
export async function unarchiveProject(api: string, projectId: string): Promise<Project> {
  const body = await request<{ project: Project }>(
    `${base(api)}/${encodeURIComponent(projectId)}/unarchive`,
    { method: "POST" },
  );
  return body.project;
}

/**
 * Delete a Project irreversibly: its record (and its Sessions' Runs) go, and the
 * service moves its workspace into a recycle bin. The UI offers no restore.
 */
export async function deleteProject(api: string, projectId: string): Promise<void> {
  await request<{ ok: true }>(`${base(api)}/${encodeURIComponent(projectId)}/delete`, {
    method: "POST",
  });
}

/** A Project's Sessions, in creation order. Archived sessions excluded by default. */
export async function fetchProjectSessions(
  api: string,
  projectId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Session[]> {
  const query = opts.includeArchived ? "?includeArchived=1" : "";
  const body = await request<{ sessions: Session[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/sessions${query}`,
  );
  return body.sessions;
}

/** Create a Session under a Project and return it (its id is the threadId). */
export async function createSession(
  api: string,
  projectId: string,
  opts: { agentId?: string; title?: string } = {},
): Promise<Session> {
  const body = await request<{ session: Session }>(
    `${base(api)}/${encodeURIComponent(projectId)}/sessions`,
    { method: "POST", body: JSON.stringify(opts) },
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
  const body = await request<{ session: Session }>(sessionPath(api, projectId, sessionId, "rename"), {
    method: "POST",
    body: JSON.stringify({ title }),
  });
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
  return `${base(api)}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/${action}`;
}

/** A Project's Runs — the turns of all its Sessions (the result rollup). */
export async function fetchProjectRuns(api: string, projectId: string): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/runs`,
  );
  return body.runs;
}

/** The Runs of ONE Session (the status bar's metrics source). */
export async function fetchSessionRuns(
  api: string,
  projectId: string,
  sessionId: string,
): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/runs?sessionId=${encodeURIComponent(sessionId)}`,
  );
  return body.runs;
}
