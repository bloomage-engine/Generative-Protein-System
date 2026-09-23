"use client";

/**
 * The Project Worktree record surface (docs/adr/0025).
 *
 * A Project's Workspace is a git repository and each Worktree is an isolated
 * checkout on its own branch (`main` IS the Project root). The workbench is a
 * thin client over the service's `/api/worktrees*` routes, so Worktree identity
 * lives in the record layer and never in the UI. Plain fetch helpers — no React
 * — so a route page can use them and they stay unit-testable.
 */
import { DEFAULT_WORKTREE_ID } from "@science-studio/record";
import type { Worktree as RecordWorktree } from "@science-studio/record";
import { RecordRequestError } from "./projects.js";

/** Re-exported so the scope resolver shares one id for the reserved worktree. */
export { DEFAULT_WORKTREE_ID };

/** A record Worktree as the service's listing decorates it. */
export interface Worktree extends RecordWorktree {
  /**
   * Whether the checkout exists on disk. The listing adds it; it is never
   * stored (the on-disk path is derived from the id — docs/adr/0025).
   */
  exists?: boolean;
}

export const DEFAULT_WORKTREES_API = "/api/worktrees";

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
    let message = `worktree request failed: ${res.status}`;
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

function query(projectId: string): string {
  return new URLSearchParams({ projectId }).toString();
}

/**
 * A Project's Worktrees, in creation order. `main` is always listed (the
 * Project root is its main worktree even before a repository exists); archived
 * ones are excluded unless asked for.
 */
export async function fetchWorktrees(
  api: string,
  projectId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Worktree[]> {
  const params = new URLSearchParams({ projectId });
  if (opts.includeArchived) params.set("includeArchived", "1");
  const body = await request<{ worktrees: Worktree[] }>(`${base(api)}?${params.toString()}`);
  return body.worktrees;
}

/**
 * Create a Worktree under a Project. The service mints the id (a slug unique
 * within the Project) and initializes the repository lazily on the first create.
 */
export async function createWorktree(
  api: string,
  projectId: string,
  input: { name: string; branch?: string; base?: string },
): Promise<Worktree> {
  const body = await request<{ worktree: Worktree }>(`${base(api)}?${query(projectId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.worktree;
}

/** Rename a Worktree (`main` is protected — the service answers 403). */
export async function renameWorktree(
  api: string,
  projectId: string,
  id: string,
  name: string,
): Promise<Worktree> {
  return worktreeAction(api, projectId, id, "rename", { name });
}

/** Archive a Worktree — hidden from the default listing, restorable. */
export async function archiveWorktree(
  api: string,
  projectId: string,
  id: string,
): Promise<Worktree> {
  return worktreeAction(api, projectId, id, "archive");
}

/** Clear a Worktree's archived flag. */
export async function unarchiveWorktree(
  api: string,
  projectId: string,
  id: string,
): Promise<Worktree> {
  return worktreeAction(api, projectId, id, "unarchive");
}

/**
 * Delete a Worktree irreversibly: its checkout and branch are removed and its
 * Sessions (and their Runs) go with it. `main` is protected.
 */
export async function deleteWorktree(
  api: string,
  projectId: string,
  id: string,
): Promise<void> {
  await request<{ ok: true }>(worktreePath(api, projectId, id, "delete"), { method: "POST" });
}

async function worktreeAction(
  api: string,
  projectId: string,
  id: string,
  action: string,
  body?: unknown,
): Promise<Worktree> {
  const res = await request<{ worktree: Worktree }>(worktreePath(api, projectId, id, action), {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.worktree;
}

function worktreePath(api: string, projectId: string, id: string, action: string): string {
  return `${base(api)}/${encodeURIComponent(id)}/${action}?${query(projectId)}`;
}
