/**
 * The `/api/mcp/*` surface (docs/adr/0026). Server rows live in the deployment
 * settings file; these routes exist because a project-scoped catalog cannot use
 * the whole-list settings PUT without letting one Project delete another's
 * rows. Reads are principal-only; every write/action is local-or-manager.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RecordStore } from "@science-studio/record";
import type { McpServerDraft, McpServerSettings } from "@science-studio/transport";
import { isSafeProjectId } from "../worktree/paths.js";
import { normalizeServer } from "./codec.js";
import { probeMcpServer, type McpProber } from "./probe.js";
import {
  createMcpServer,
  deleteMcpServer,
  findMcpServer,
  listMcpServers,
  McpConfigError,
  updateMcpServer,
} from "./store.js";

export interface McpRouteDeps {
  settingsPath: string;
  records: RecordStore;
  /** Whether the ACTIVE runtime consumes this catalog (dsh: true). */
  available: boolean;
  /** Test seam; the real prober owns the SDK connection. */
  probe?: McpProber;
  /** The agent root for the active scope, used when a stdio server has no cwd. */
  workspaceRoot?: (projectId: string, worktreeId: string) => string;
  /** Test seam: shorten the probe deadline. */
  probeTimeoutMs?: number;
}

function canManage(principal: { local: boolean; roles: readonly string[] }): boolean {
  return principal.local || principal.roles.includes("manager");
}

function forbidden(reply: FastifyReply): FastifyReply {
  return reply
    .code(403)
    .send({ error: "changing MCP servers requires a local or manager principal" });
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof McpConfigError) return reply.code(err.status).send({ error: err.message });
  return null;
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function requireProject(records: RecordStore, projectId: string): Promise<void> {
  if (!(await records.getProject(projectId))) {
    throw new McpConfigError(`unknown Project "${projectId}"`);
  }
}

async function validateProjectScope(
  records: RecordStore,
  server: McpServerSettings,
): Promise<void> {
  if (server.scope === "project" && server.projectId) {
    await requireProject(records, server.projectId);
  }
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  app.get("/api/mcp/servers", async (request, reply) => {
    const query = request.query as { projectId?: unknown };
    let projectId: string | undefined;
    if (query.projectId !== undefined) {
      if (typeof query.projectId !== "string" || !isSafeProjectId(query.projectId)) {
        return reply.code(400).send({ error: "unsafe projectId" });
      }
      projectId = query.projectId;
    }
    return {
      available: deps.available,
      servers: await listMcpServers(deps.settingsPath, projectId),
    };
  });

  app.post("/api/mcp/servers", async (request, reply) => {
    const principal = request.principal!;
    if (!canManage(principal)) return forbidden(reply);
    const body = bodyObject(request.body);
    if (!body) return reply.code(400).send({ error: "body must be a JSON object" });
    try {
      const draft = body as McpServerDraft;
      const parsed = normalizeServer(draft, undefined);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      await validateProjectScope(deps.records, parsed.value);
      return reply.code(201).send({ server: await createMcpServer(deps.settingsPath, body) });
    } catch (err) {
      const mapped = sendError(reply, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.put("/api/mcp/servers/:id", async (request, reply) => {
    const principal = request.principal!;
    if (!canManage(principal)) return forbidden(reply);
    const { id } = request.params as { id: string };
    const body = bodyObject(request.body);
    if (!body) return reply.code(400).send({ error: "body must be a JSON object" });
    try {
      const existing = await findMcpServer(deps.settingsPath, id);
      if (!existing) return reply.code(404).send({ error: `unknown MCP server "${id}"` });
      const parsed = normalizeServer({ ...body, id }, existing);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      await validateProjectScope(deps.records, parsed.value);
      return { server: await updateMcpServer(deps.settingsPath, id, body) };
    } catch (err) {
      const mapped = sendError(reply, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.delete("/api/mcp/servers/:id", async (request, reply) => {
    const principal = request.principal!;
    if (!canManage(principal)) return forbidden(reply);
    const { id } = request.params as { id: string };
    try {
      await deleteMcpServer(deps.settingsPath, id);
      return { ok: true };
    } catch (err) {
      const mapped = sendError(reply, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post("/api/mcp/probe", async (request, reply) => {
    const principal = request.principal!;
    if (!canManage(principal)) return forbidden(reply);
    const body = bodyObject(request.body);
    if (!body) return reply.code(400).send({ error: "body must be a JSON object" });
    const draft = body.server;
    if (draft === undefined) return reply.code(400).send({ error: "server is required" });
    const id = typeof body.id === "string" && body.id !== "" ? body.id : undefined;
    let projectId: string | undefined;
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== "string" || !isSafeProjectId(body.projectId)) {
        return reply.code(400).send({ error: "unsafe projectId" });
      }
      projectId = body.projectId;
    }
    let worktreeId = "main";
    if (body.worktreeId !== undefined) {
      if (typeof body.worktreeId !== "string" || !isSafeProjectId(body.worktreeId)) {
        return reply.code(400).send({ error: "unsafe worktreeId" });
      }
      worktreeId = body.worktreeId;
    }

    try {
      if (projectId) await requireProject(deps.records, projectId);
      const existing = id ? await findMcpServer(deps.settingsPath, id) : undefined;
      if (id && !existing) {
        return reply.code(404).send({ error: `unknown MCP server "${id}"` });
      }
      const parsed = normalizeServer({ ...(draft as McpServerDraft), ...(id ? { id } : {}) }, existing);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      await validateProjectScope(deps.records, parsed.value);

      const scopeProject = projectId ?? parsed.value.projectId;
      const root = scopeProject
        ? deps.workspaceRoot?.(scopeProject, worktreeId) || undefined
        : undefined;
      const prober: McpProber = deps.probe ?? { probe: probeMcpServer };
      return await prober.probe(parsed.value, {
        ...(root ? { cwd: root } : {}),
        ...(deps.probeTimeoutMs ? { timeoutMs: deps.probeTimeoutMs } : {}),
      });
    } catch (err) {
      const mapped = sendError(reply, err);
      if (mapped) return mapped;
      throw err;
    }
  });
}
