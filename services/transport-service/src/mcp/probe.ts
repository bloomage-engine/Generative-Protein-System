/**
 * One-shot MCP connectivity probe for the workbench's Test connection button.
 * It is deliberately independent of the agent runtime: it connects, lists the
 * server's tools, and disconnects. The dsh child owns the long-lived connection
 * the model actually uses (docs/adr/0026).
 */
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSettings } from "@science-studio/transport";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 200;
const MAX_DESCRIPTION = 500;
const MAX_STDERR = 4_000;

const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;

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

export interface McpProbeOptions {
  /** stdio only: the directory the agent would run in (the worktree root). */
  cwd?: string;
  /** Override the connect/list deadline (tests use a short one). */
  timeoutMs?: number;
}

export interface McpProber {
  probe(server: McpServerSettings, options?: McpProbeOptions): Promise<McpProbeResult>;
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV.test(key) || key.startsWith("DSH_")) continue;
    out[key] = value;
  }
  return out;
}

function secretValues(server: McpServerSettings): string[] {
  return [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) out = out.split(secret).join("***");
  return out.slice(0, 2_000);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bounded stderr tail for a failed stdio probe; drained so it cannot block. */
function stderrTail(stream: Stream | null): () => string {
  if (!stream) return () => "";
  const chunks: Buffer[] = [];
  let total = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total >= MAX_STDERR) return;
    const room = MAX_STDERR - total;
    chunks.push(buffer.subarray(0, room));
    total += Math.min(buffer.length, room);
  });
  stream.on("error", () => undefined);
  return () => Buffer.concat(chunks).toString("utf8").trim();
}

export const probeMcpServer: McpProber["probe"] = async (
  server: McpServerSettings,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> => {
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const secrets = secretValues(server);
  let client: Client | undefined;
  let readStderr: () => string = () => "";

  try {
    client = new Client(
      { name: "science-studio", version: "0.1.0" },
      { capabilities: {} },
    );

    let transport;
    if (server.transport === "stdio") {
      if (!server.command) return { ok: false, error: "stdio server has no command" };
      const stdio = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...scrubbedEnv(), ...(server.env ?? {}) },
        ...((server.cwd ?? options.cwd) ? { cwd: server.cwd ?? options.cwd } : {}),
        stderr: "pipe",
      });
      readStderr = stderrTail(stdio.stderr);
      transport = stdio;
    } else {
      if (!server.url) return { ok: false, error: "streamable-http server has no url" };
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      });
    }

    await withTimeout(client.connect(transport), timeoutMs, "MCP connection");
    const listed = await withTimeout(client.listTools(), timeoutMs, "MCP tools/list");
    const tools = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description.slice(0, MAX_DESCRIPTION) } : {}),
    }));
    const version = client.getServerVersion();
    return {
      ok: true,
      ...(version
        ? { serverInfo: { name: version.name, version: version.version } }
        : {}),
      toolCount: tools.length,
      tools: tools.slice(0, MAX_TOOLS),
    };
  } catch (err) {
    const tail = readStderr();
    const detail = redact(
      tail ? `${errorMessage(err)}\n${tail}` : errorMessage(err),
      secrets,
    );
    return { ok: false, error: detail };
  } finally {
    await client?.close().catch(() => undefined);
  }
};
