/**
 * File-backed CRUD over the deployment MCP catalog. The settings file stays
 * the one store; these helpers only add the per-row writes a project-scoped
 * catalog needs (a whole-list PUT would let one Project delete another's rows).
 */
import type {
  McpServerDraft,
  McpServerSettings,
  McpServerView,
} from "@science-studio/transport";
import { loadSettings, saveSettings } from "../settings.js";
import { normalizeServer, serversForProject, viewMcpServer } from "./codec.js";

export class McpConfigError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

async function readServers(settingsPath: string): Promise<McpServerSettings[]> {
  return (await loadSettings(settingsPath)).mcp?.servers ?? [];
}

async function writeServers(
  settingsPath: string,
  servers: McpServerSettings[],
): Promise<void> {
  const settings = await loadSettings(settingsPath);
  await saveSettings(settingsPath, { ...settings, mcp: { servers } });
}

export async function listMcpServers(
  settingsPath: string,
  projectId: string | undefined,
): Promise<McpServerView[]> {
  return serversForProject(await readServers(settingsPath), projectId).map(viewMcpServer);
}

export async function createMcpServer(
  settingsPath: string,
  draft: McpServerDraft,
): Promise<McpServerView> {
  const servers = await readServers(settingsPath);
  const parsed = normalizeServer(draft, undefined);
  if ("error" in parsed) throw new McpConfigError(parsed.error);
  if (servers.some((server) => server.id === parsed.value.id)) {
    throw new McpConfigError(`an MCP server with id "${parsed.value.id}" already exists`, 409);
  }
  servers.push(parsed.value);
  await writeServers(settingsPath, servers);
  return viewMcpServer(parsed.value);
}

export async function updateMcpServer(
  settingsPath: string,
  id: string,
  draft: McpServerDraft,
): Promise<McpServerView> {
  const servers = await readServers(settingsPath);
  const index = servers.findIndex((server) => server.id === id);
  if (index < 0) throw new McpConfigError(`unknown MCP server "${id}"`, 404);
  const parsed = normalizeServer({ ...draft, id }, servers[index]);
  if ("error" in parsed) throw new McpConfigError(parsed.error);
  if (servers.some((server, i) => i !== index && server.id === parsed.value.id)) {
    throw new McpConfigError(`an MCP server with id "${parsed.value.id}" already exists`, 409);
  }
  servers[index] = parsed.value;
  await writeServers(settingsPath, servers);
  return viewMcpServer(parsed.value);
}

export async function deleteMcpServer(settingsPath: string, id: string): Promise<void> {
  const servers = await readServers(settingsPath);
  const next = servers.filter((server) => server.id !== id);
  if (next.length === servers.length) {
    throw new McpConfigError(`unknown MCP server "${id}"`, 404);
  }
  await writeServers(settingsPath, next);
}

/** Best-effort cleanup when a Project is deleted; callers log, never fail the delete. */
export async function removeMcpServersForProject(
  settingsPath: string,
  projectId: string,
): Promise<void> {
  const servers = await readServers(settingsPath);
  const next = servers.filter(
    (server) => !(server.scope === "project" && server.projectId === projectId),
  );
  if (next.length === servers.length) return;
  await writeServers(settingsPath, next);
}

/** The effective stored server for a probe/update, credentials included. */
export async function findMcpServer(
  settingsPath: string,
  id: string,
): Promise<McpServerSettings | undefined> {
  return (await readServers(settingsPath)).find((server) => server.id === id);
}
