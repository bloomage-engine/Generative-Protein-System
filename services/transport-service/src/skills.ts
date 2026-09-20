/**
 * The `/api/skills*` request shaping and error mapping (docs/adr/0020). The
 * runtime adapter owns the skill FORMAT; this module only validates the HTTP
 * body's types and maps the adapter's seam errors onto statuses, so the routes
 * stay thin and the service stays runtime-agnostic.
 */
import type { FastifyReply } from "fastify";
import {
  SkillExistsError,
  SkillInvalidError,
  SkillNotFoundError,
  WorkspacePathError,
  WorkspaceUnavailableError,
  type SkillInstallInput,
  type SkillInvocationPolicy,
} from "@science-studio/transport";

/** Validate a skill-install body, returning the typed input or an error string. */
export function parseSkillInstall(body: unknown): { input: SkillInstallInput } | { error: string } {
  const raw = asObject(body);
  if (raw === null) return { error: "skills install body must be a JSON object" };
  const input: SkillInstallInput = {};

  for (const key of ["name", "description", "body"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${key} must be a string` };
    input[key] = value;
  }

  if (raw.invocation !== undefined) {
    const invocation = asObject(raw.invocation);
    if (invocation === null) return { error: "invocation must be an object" };
    const parsed: Partial<SkillInvocationPolicy> = {};
    for (const key of ["modelInvocable", "userInvocable"] as const) {
      const value = invocation[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return { error: `invocation.${key} must be a boolean` };
      parsed[key] = value;
    }
    input.invocation = parsed;
  }

  if (raw.copyFrom !== undefined) {
    const copyFrom = asObject(raw.copyFrom);
    if (copyFrom === null) return { error: "copyFrom must be an object" };
    if (typeof copyFrom.name !== "string" || copyFrom.name === "") {
      return { error: "copyFrom.name is required" };
    }
    input.copyFrom = { name: copyFrom.name };
  }

  if (raw.overwrite !== undefined) {
    if (typeof raw.overwrite !== "boolean") return { error: "overwrite must be a boolean" };
    input.overwrite = raw.overwrite;
  }

  if (input.copyFrom === undefined) {
    if (typeof input.name !== "string" || input.name === "") return { error: "name is required" };
    if (typeof input.description !== "string" || input.description.trim() === "") {
      return { error: "description is required" };
    }
  }
  return { input };
}

/** Validate a skill-remove body (name + an explicit confirm). */
export function parseSkillRemove(body: unknown): { name: string } | { error: string } {
  const raw = asObject(body);
  if (raw === null) return { error: "skills remove body must be a JSON object" };
  if (typeof raw.name !== "string" || raw.name === "") return { error: "name is required" };
  if (raw.confirm !== true) return { error: "confirm must be true" };
  return { name: raw.name };
}

/** Map a skills-seam error onto an HTTP status; rethrow anything unrecognized. */
export function sendSkillError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SkillInvalidError) return reply.code(400).send({ error: err.message });
  if (err instanceof SkillExistsError) return reply.code(409).send({ error: err.message });
  if (err instanceof SkillNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof WorkspaceUnavailableError) return reply.code(503).send({ error: err.message });
  if (err instanceof WorkspacePathError) return reply.code(400).send({ error: err.message });
  throw err;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
