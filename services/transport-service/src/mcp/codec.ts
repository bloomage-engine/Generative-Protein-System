/**
 * Pure codec for the deployment MCP catalog (docs/adr/0026): validation,
 * secret-safe projection, and the scope filter. No filesystem here so the
 * settings loader and the CRUD routes share exactly one rule set.
 */
import type {
  McpScope,
  McpServerDraft,
  McpServerSettings,
  McpServerView,
  McpSettings,
} from "@gps/transport";
import { isSafeProjectId } from "../worktree/paths.js";

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_ENTRIES = 128;
const MAX_VALUE_LENGTH = 64 * 1024;
const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGS = 256;
const MAX_URL_LENGTH = 4096;

type Result<T> = { value: T } | { error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(label: string, message: string): { error: string } {
  return { error: `${label} ${message}` };
}

function text(value: unknown, label: string, max = MAX_VALUE_LENGTH): Result<string> {
  if (typeof value !== "string") return bad(label, "must be a string");
  if (value.includes("\0")) return bad(label, "must not contain NUL");
  if (value.length > max) return bad(label, `must be at most ${max} characters`);
  return { value };
}

function stringArray(value: unknown, label: string): Result<string[]> {
  if (!Array.isArray(value)) return bad(label, "must be an array of strings");
  if (value.length > MAX_ARGS) return bad(label, `must have at most ${MAX_ARGS} items`);
  const args: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const parsed = text(value[i], `${label}[${i}]`);
    if ("error" in parsed) return parsed;
    args.push(parsed.value);
  }
  return { value: args };
}

/**
 * Merge a secret map patch over the stored map. An omitted field keeps the
 * stored map, `null` clears it, and an object applies key-by-key (`null`
 * removes one key). This is what lets the workbench edit an existing server
 * without ever reading its credentials back.
 */
function mergeSecrets(
  base: Record<string, string> | undefined,
  patch: Record<string, string | null> | null | undefined,
  keyPattern: RegExp,
  label: string,
  valueLabel: string,
): Result<Record<string, string> | undefined> {
  if (patch === undefined) return { value: base };
  if (patch === null) return { value: undefined };
  if (!isPlainObject(patch)) return bad(label, "must be an object or null");
  const entries = Object.entries(patch);
  if (entries.length > MAX_ENTRIES) return bad(label, `must have at most ${MAX_ENTRIES} keys`);
  const out: Record<string, string> = { ...(base ?? {}) };
  for (const [key, value] of entries) {
    if (!keyPattern.test(key)) return bad(`${label} key`, `"${key}" is not a valid name`);
    if (value === null) {
      delete out[key];
      continue;
    }
    const parsed = text(value, `${label}.${key}`);
    if ("error" in parsed) return parsed;
    if (valueLabel === "header" && /[\r\n]/.test(parsed.value)) {
      return bad(`${label}.${key}`, "must not contain CR or LF");
    }
    out[key] = parsed.value;
  }
  return { value: Object.keys(out).length > 0 ? out : undefined };
}

function scopeOf(value: unknown, label: string): Result<McpScope> {
  if (value === "global" || value === "project") return { value };
  return bad(label, 'must be "global" or "project"');
}

function projectOf(
  scope: McpScope,
  value: unknown,
  label: string,
): Result<string | undefined> {
  if (scope === "global") {
    if (value !== undefined) return bad(label, "must be omitted for a global server");
    return { value: undefined };
  }
  const parsed = text(value, label, 256);
  if ("error" in parsed) return parsed;
  if (!isSafeProjectId(parsed.value)) return bad(label, "is not a safe Project id");
  return { value: parsed.value };
}

function transportOf(value: unknown, label: string): Result<"stdio" | "streamable-http"> {
  if (value === "stdio" || value === "streamable-http") return { value };
  return bad(label, 'must be "stdio" or "streamable-http"');
}

function timeoutOf(value: unknown, label: string): Result<number | undefined> {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > 600_000) {
    return bad(label, "must be an integer between 1000 and 600000");
  }
  return { value };
}

function httpUrl(value: unknown, label: string): Result<string> {
  const parsed = text(value, label, MAX_URL_LENGTH);
  if ("error" in parsed) return parsed;
  try {
    const url = new URL(parsed.value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return bad(label, "must be an http(s) URL");
    }
    if (!url.hostname) return bad(label, "must include a host");
  } catch {
    return bad(label, "must be an http(s) URL");
  }
  return { value: parsed.value };
}

/**
 * Normalize a create/update draft (or one stored row) into a stored server.
 * `existing` supplies the values a draft may omit, including credentials.
 */
export function normalizeServer(
  raw: unknown,
  existing: McpServerSettings | undefined,
): Result<McpServerSettings> {
  if (!isPlainObject(raw)) return { error: "must be an object" };
  const input = raw as McpServerDraft;

  const id = text(input.id ?? existing?.id, "id", 32);
  if ("error" in id) return id;
  if (!ID.test(id.value)) {
    return bad("id", "must match [A-Za-z0-9_-]{1,32}");
  }

  const scope = scopeOf(input.scope ?? existing?.scope, "scope");
  if ("error" in scope) return scope;
  const projectInput =
    scope.value === "global" ? input.projectId : (input.projectId ?? existing?.projectId);
  const project = projectOf(scope.value, projectInput, "projectId");
  if ("error" in project) return project;

  const transport = transportOf(input.transport ?? existing?.transport, "transport");
  if ("error" in transport) return transport;
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== "boolean") return bad("enabled", "must be a boolean");
  const timeout = timeoutOf(
    input.toolCallTimeoutMs ?? existing?.toolCallTimeoutMs,
    "toolCallTimeoutMs",
  );
  if ("error" in timeout) return timeout;

  if (transport.value === "stdio") {
    const command = text(
      input.command ?? existing?.command,
      "command",
      MAX_COMMAND_LENGTH,
    );
    if ("error" in command) return command;
    if (command.value.trim() === "") return bad("command", "is required for stdio");
    const args =
      input.args === undefined
        ? { value: existing?.args }
        : stringArray(input.args, "args");
    if ("error" in args) return args;
    const env = mergeSecrets(
      existing?.env,
      input.env,
      ENV_KEY,
      "env",
      "env",
    );
    if ("error" in env) return env;
    let cwd = existing?.cwd;
    if (input.cwd !== undefined) {
      const parsed = text(input.cwd, "cwd", MAX_COMMAND_LENGTH);
      if ("error" in parsed) return parsed;
      cwd = parsed.value.trim() === "" ? undefined : parsed.value;
    }
    return {
      value: {
        id: id.value,
        scope: scope.value,
        ...(project.value === undefined ? {} : { projectId: project.value }),
        enabled,
        transport: "stdio",
        command: command.value,
        ...(args.value === undefined ? {} : { args: args.value }),
        ...(env.value === undefined ? {} : { env: env.value }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(timeout.value === undefined ? {} : { toolCallTimeoutMs: timeout.value }),
      },
    };
  }

  const url = httpUrl(input.url ?? existing?.url, "url");
  if ("error" in url) return url;
  const headers = mergeSecrets(
    existing?.headers,
    input.headers,
    HEADER_KEY,
    "headers",
    "header",
  );
  if ("error" in headers) return headers;
  return {
    value: {
      id: id.value,
      scope: scope.value,
      ...(project.value === undefined ? {} : { projectId: project.value }),
      enabled,
      transport: "streamable-http",
      url: url.value,
      ...(headers.value === undefined ? {} : { headers: headers.value }),
      ...(timeout.value === undefined ? {} : { toolCallTimeoutMs: timeout.value }),
    },
  };
}

/** A stored row from the settings file; invalid rows are dropped by the loader. */
export function parseMcpSettings(value: unknown): {
  settings: McpSettings;
  errors: string[];
} {
  if (value === undefined) return { settings: { servers: [] }, errors: [] };
  if (!isPlainObject(value) || !Array.isArray(value.servers)) {
    return { settings: { servers: [] }, errors: ["mcp.servers must be an array"] };
  }
  const servers: McpServerSettings[] = [];
  const errors: string[] = [];
  for (let index = 0; index < value.servers.length; index += 1) {
    const parsed = normalizeServer(value.servers[index], undefined);
    if ("error" in parsed) {
      errors.push(`mcp.servers[${index}]: ${parsed.error}`);
      continue;
    }
    if (servers.some((server) => server.id === parsed.value.id)) {
      errors.push(`mcp.servers[${index}]: duplicate id "${parsed.value.id}"`);
      continue;
    }
    servers.push(parsed.value);
  }
  return { settings: { servers }, errors };
}

/** The `GET` projection: credential key names only. */
export function viewMcpServer(server: McpServerSettings): McpServerView {
  const { env, headers, ...rest } = server;
  return {
    ...rest,
    envKeys: Object.keys(env ?? {}).sort(),
    headerKeys: Object.keys(headers ?? {}).sort(),
  };
}

/** The rows a Project's child should see: all global rows plus its own. */
export function serversForProject(
  servers: readonly McpServerSettings[],
  projectId: string | undefined,
): McpServerSettings[] {
  return servers.filter(
    (server) =>
      server.scope === "global" ||
      (projectId !== undefined && server.projectId === projectId),
  );
}
