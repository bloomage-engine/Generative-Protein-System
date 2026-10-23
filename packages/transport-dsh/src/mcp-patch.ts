/**
 * Per-launch patch for the deployment MCP catalog (docs/adr/0026). One plugin
 * instance per server; the config is an `!!js` expression that reads the
 * filtered JSON from the child's env, so credentials never touch this file.
 *
 * The stored row and the dsh plugin config are deliberately not the same shape:
 * the catalog carries Project scope/enabled/id, while the plugin wants
 * `serverName` and its transport fields. Map once, here.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerSettings } from "@science-studio/transport";

export const MCP_CONFIG_ENV = "SS_MCP_SECRET_CONFIG";

/** The subset of `@deepseek-ai/dsh-mcp-client`'s config this deployment emits. */
export interface DshMcpConfig {
  serverName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
}

export function dshMcpConfig(server: McpServerSettings): DshMcpConfig {
  const common = {
    serverName: server.id,
    ...(server.toolCallTimeoutMs === undefined
      ? {}
      : { toolCallTimeoutMs: server.toolCallTimeoutMs }),
  };
  if (server.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      command: server.command ?? "",
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    };
  }
  return {
    ...common,
    transport: "streamable-http",
    url: server.url ?? "",
    ...(server.headers === undefined ? {} : { headers: server.headers }),
  };
}

export function dshMcpConfigs(servers: readonly McpServerSettings[]): DshMcpConfig[] {
  return servers.map(dshMcpConfig);
}

export async function writeMcpPatch(opts: {
  dir: string;
  configs: readonly DshMcpConfig[];
}): Promise<string> {
  const { dir, configs } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `mcp-${randomUUID().slice(0, 8)}.cordis.patch.yml`);
  const lines = ["- insert:"];
  for (let index = 0; index < configs.length; index += 1) {
    const expression = `JSON.parse(process.env.${MCP_CONFIG_ENV})[${index}]`;
    lines.push(`    - id: science-studio-mcp-${index}`);
    lines.push('      name: "@deepseek-ai/dsh-mcp-client"');
    lines.push(`      config: !!js ${JSON.stringify(expression)}`);
  }
  lines.push("");
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}
