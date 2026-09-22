/**
 * The Project HPC Binding (docs/adr/0024): the one workspace file
 * `.science-studio/hpc.md` by which a Project selects an HPC Endpoint and
 * carries its Project-level defaults. House-style frontmatter (JSON-quoted
 * scalars, the `@science-studio/cron` codec's shape) with the body as free
 * cluster-use notes the Researcher keeps for the Agent.
 *
 * The Binding is Project state, not deployment settings: endpoints carry the
 * connection (and its key-file path), the Binding names WHICH one and with
 * which defaults. It is written only by the workbench (through the Workspace
 * seam); the agent reads it in its cwd but has no write tool.
 */

/** The binding's path inside a Project Workspace. */
export const HPC_BINDING_PATH = ".science-studio/hpc.md";

/** Endpoint ids: the cron id grammar — stable, filename-safe, listable. */
const ENDPOINT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HpcBinding {
  /** The endpoint id this Project submits to (an HpcEndpointSettings.id). */
  endpoint: string;
  /** Overrides the endpoint's defaultPartition when set. */
  partition?: string;
  /** Overrides `defaultWorkDir(projectId)` when set. */
  workDir?: string;
  /** Overrides the endpoint's defaultTime when set. */
  defaultTime?: string;
  /** The frontmatter body: freeform cluster-use notes. */
  notes: string;
}

export type BindingParseResult = { binding: HpcBinding } | { error: string };

export function isValidEndpointId(id: string): boolean {
  return ENDPOINT_ID.test(id);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  return trimmed;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function parseHpcBinding(text: string): BindingParseResult {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { error: "missing frontmatter" };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { error: "unterminated frontmatter" };
  const header = normalized.slice(4, end);
  const notes = normalized.slice(end + 4).replace(/^\n+/, "");
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) return { error: `malformed frontmatter line: ${line}` };
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const endpoint = unquote(fields.get("endpoint") ?? "");
  if (endpoint === "") return { error: "missing endpoint" };
  if (!isValidEndpointId(endpoint)) return { error: `invalid endpoint id: ${endpoint}` };
  const partition = unquote(fields.get("partition") ?? "");
  const workDir = unquote(fields.get("workDir") ?? "");
  const defaultTime = unquote(fields.get("defaultTime") ?? "");
  return {
    binding: {
      endpoint,
      ...(partition !== "" ? { partition } : {}),
      ...(workDir !== "" ? { workDir } : {}),
      ...(defaultTime !== "" ? { defaultTime } : {}),
      notes,
    },
  };
}

export function serializeHpcBinding(binding: HpcBinding): string {
  const lines = ["---", `endpoint: ${quote(binding.endpoint)}`];
  if (binding.partition) lines.push(`partition: ${quote(binding.partition)}`);
  if (binding.workDir) lines.push(`workDir: ${quote(binding.workDir)}`);
  if (binding.defaultTime) lines.push(`defaultTime: ${quote(binding.defaultTime)}`);
  lines.push("---", "", binding.notes ?? "");
  return lines.join("\n");
}
