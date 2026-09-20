"use client";

import type { SkillInfo, SkillInstallInput } from "@science-studio/transport";

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
  /** The Project whose adapter serves the catalog. */
  projectId?: string;
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

function base(api: string): string {
  return api.replace(/\/+$/, "");
}

function query(projectId?: string): string {
  return projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
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
 * Read the Project's skills catalog. A failed hop degrades to an unavailable
 * empty view so the tab shows a neutral state rather than an error (the same
 * fail-soft policy the Subagents proxy uses).
 */
export async function fetchSkills(options: SkillsApiOptions = {}): Promise<SkillsView> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  try {
    return await request<SkillsView>(`${base(api)}${query(options.projectId)}`);
  } catch {
    return { available: false, runtime: "", skills: [] };
  }
}

/** Install (or overwrite) one Project skill; returns the installed skill. */
export async function installSkill(options: SkillsApiOptions, input: SkillInstallInput): Promise<SkillInfo> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  const { skill } = await request<{ skill: SkillInfo }>(`${base(api)}/install${query(options.projectId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return skill;
}

/** Remove one Project skill. */
export async function removeSkill(options: SkillsApiOptions, name: string): Promise<void> {
  const api = options.api ?? DEFAULT_SKILLS_API;
  await request<{ removed: string }>(`${base(api)}/remove${query(options.projectId)}`, {
    method: "POST",
    body: JSON.stringify({ name, confirm: true }),
  });
}
