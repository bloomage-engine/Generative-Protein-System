"use client";

import type { SkillInfo, SkillInstallInput } from "@gps/transport";
import { scopedUrl, type ClientScope } from "./scope.js";

export const DEFAULT_SKILLS_API = "/api/skills";

/** The skills catalog for one Project: global + project entries, or unavailable. */
export interface SkillsView {
  /** False when the active runtime has no skills surface (e.g. openclaw). */
  available: boolean;
  runtime: string;
  skills: SkillInfo[];
}

export interface SkillsApiOptions {
  /** The skills API base; defaults to the same-origin `/api/skills`. */
  api?: string;
  /** The Project whose adapter serves the catalog (skills are Project-level; a Worktree claim is dropped). */
  scope?: ClientScope;
}

export class SkillsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SkillsRequestError";
  }
}

/**
 * The skills surface is PROJECT-level (docs/adr/0020): the catalog rides the
 * active Project's adapter and the install target is the Project's workspace
 * root, so any Worktree claim is dropped here.
 */
function projectScope(scope?: ClientScope): ClientScope {
  return { projectId: scope?.projectId ?? null };
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    let message = `skills request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new SkillsRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

/**
 * Read the Project's skills catalog. A non-2xx throws `SkillsRequestError`, so
 * the caller owns the failure decision (docs/adr/0021): the tab separates a
 * transport failure (an error state) from the service's `available:false`
 * "no skills surface" answer.
 */
export async function fetchSkills(options: SkillsApiOptions = {}): Promise<SkillsView> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  return request<SkillsView>(scopedUrl(api, "", projectScope(options.scope)));
}

/** Install (or overwrite) one Project skill; returns the installed skill. */
export async function installSkill(options: SkillsApiOptions, input: SkillInstallInput): Promise<SkillInfo> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  const { skill } = await request<{ skill: SkillInfo }>(
    scopedUrl(api, "/install", projectScope(options.scope)),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return skill;
}

/** Remove one Project skill. */
export async function removeSkill(options: SkillsApiOptions, name: string): Promise<void> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  await request<{ removed: string }>(scopedUrl(api, "/remove", projectScope(options.scope)), {
    method: "POST",
    body: JSON.stringify({ name, confirm: true }),
  });
}
