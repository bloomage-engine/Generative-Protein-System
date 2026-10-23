"use client";

import type {
  McpServerDraft,
  McpServerView,
} from "@science-studio/transport";
import { scopedUrl } from "./scope.js";

/** The same-origin MCP proxy base (the web hop). */
export const DEFAULT_MCP_API = "/api/mcp";

export class McpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRequestError";
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    let message = `mcp request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new McpRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface McpServersView {
  available: boolean;
  servers: McpServerView[];
}

export interface McpServerResponse {
  server: McpServerView;
}

export interface McpProbeTool {
  name: string;
  description?: string;
}

export interface McpProbeResult {
  ok: boolean;
  serverInfo?: { name: string; version: string };
  toolCount?: number;
  tools?: McpProbeTool[];
  error?: string;
}

export function fetchMcpServers(
  api: string = DEFAULT_MCP_API,
  scope: { projectId?: string | null; worktreeId?: string | null } = {},
  signal?: AbortSignal,
): Promise<McpServersView> {
  return request<McpServersView>(
    scopedUrl(api, "/servers", {
      projectId: scope.projectId ?? null,
      worktreeId: scope.worktreeId ?? null,
    }),
    { signal },
  );
}

export function createMcpServer(
  api: string,
  draft: McpServerDraft,
): Promise<McpServerResponse> {
  return request<McpServerResponse>(`${api}/servers`, {
    method: "POST",
    body: JSON.stringify(draft),
  });
}

export function updateMcpServer(
  api: string,
  id: string,
  draft: McpServerDraft,
): Promise<McpServerResponse> {
  return request<McpServerResponse>(`${api}/servers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(draft),
  });
}

export function deleteMcpServer(api: string, id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`${api}/servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface McpProbeInput {
  id?: string;
  projectId?: string | null;
  worktreeId?: string | null;
  server: McpServerDraft;
}

export function probeMcpServer(
  api: string,
  input: McpProbeInput,
): Promise<McpProbeResult> {
  return request<McpProbeResult>(`${api}/probe`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
