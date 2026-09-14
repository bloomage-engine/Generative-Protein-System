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
  const res = await fetch(input, {
    headers: { accept: "application/json", "content-type": "application/json" },
    ...init,
  });
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

/** Create a Project; the service mints its id (a filesystem-safe slug). */
export async function createProject(
  api: string,
  name: string,
): Promise<Project> {
  const body = await request<{ project: Project }>(`${base(api)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return body.project;
}

/** A Project's Sessions, in creation order. */
export async function fetchProjectSessions(
  api: string,
  projectId: string,
): Promise<Session[]> {
  const body = await request<{ sessions: Session[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/sessions`,
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

/** A Project's Runs — the turns of all its Sessions (the result rollup). */
export async function fetchProjectRuns(api: string, projectId: string): Promise<Run[]> {
  const body = await request<{ runs: Run[] }>(
    `${base(api)}/${encodeURIComponent(projectId)}/runs`,
  );
  return body.runs;
}
