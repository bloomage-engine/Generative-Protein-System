/**
 * The deployment settings file: where the workbench's Model / Plugins / Agent
 * dialog persists. Deployment configuration, NOT record rows — the record stays
 * authoritative for Project/Session identity (docs/adr/0002, 0007).
 *
 * The key is stored plaintext (a single-user local install has no secret
 * store) but is write-only over HTTP and never logged.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  HpcEndpointSettings,
  HpcSettings,
  HpcSettingsPatch,
  McpHttpServerSettings,
  McpServerPatch,
  McpServerSettings,
  McpServerView,
  McpSettings,
  McpSettingsPatch,
  McpStdioServerSettings,
  ModelSettings,
  RuntimeSettings,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
  SubagentSettings,
  SubagentSettingsPatch,
  ThreadSettings,
  ThreadSettingsPatch,
} from "@science-studio/transport";
import { MCP_SERVER_NAME_GRAMMAR } from "@science-studio/transport";
import { isSafeRemotePath, isValidEndpointId } from "@science-studio/hpc";

export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SS_SETTINGS_PATH) return env.SS_SETTINGS_PATH;
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "science-studio", "settings.json");
}

export function emptySettings(): RuntimeSettings {
  return {
    model: {},
    plugins: {},
    agent: {},
    subagents: {},
    thread: {},
    hpc: { endpoints: [] },
    mcp: { servers: [] },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain hostname / IPv4 / IPv6-literal / ssh-config alias — first char alnum. */
const HOST_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,252}$/;
const USER_GRAMMAR = /^[A-Za-z0-9._-]{1,63}$/;

/**
 * Validate one endpoint definition into a clean `HpcEndpointSettings` (the
 * single source for both the `PUT` path and a hand-edited settings file). An
 * endpoint the service could not SSH with is refused at the door: a typo in
 * `host`/`id`/`kind` is a config bug, and a broken row must not poison the
 * whole list.
 */
export function validateHpcEndpoint(raw: unknown, index: number): { endpoint: HpcEndpointSettings } | { error: string } {
  const label = `hpc.endpoints[${index}]`;
  if (!isPlainObject(raw)) return { error: `${label} must be an object` };
  const text = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const id = text("id") ?? "";
  if (!isValidEndpointId(id)) return { error: `${label}.id must match [a-z0-9][a-z0-9-]{0,63}` };
  const name = text("name");
  if (!name) return { error: `${label}.name is required` };
  const kind = text("kind");
  if (kind !== "slurm" && kind !== "linux") return { error: `${label}.kind must be "slurm" or "linux"` };
  // host/user/keyPath reach the ssh argv positionally, so the one thing they
  // must NEVER be is an option: a leading `-` would let a settings value drive
  // ssh's own parser (`-oProxyCommand=…` executes on the SERVICE host). The
  // grammars below forbid that by construction (first char alnum, no shell).
  const host = text("host");
  if (!host || !HOST_GRAMMAR.test(host)) {
    return { error: `${label}.host must be a plain hostname/IP/ssh-config alias (no spaces, not starting with '-')` };
  }
  const user = text("user");
  if (user !== undefined && !USER_GRAMMAR.test(user)) {
    return { error: `${label}.user must be a plain username` };
  }
  const keyPath = text("keyPath");
  if (keyPath !== undefined && !isSafeRemotePath(keyPath)) {
    return { error: `${label}.keyPath must be a safe path (no spaces, no '..', not starting with '-')` };
  }
  const port = raw.port;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return { error: `${label}.port must be an integer between 1 and 65535` };
  }
  const maxConcurrentJobs = raw.maxConcurrentJobs;
  if (
    maxConcurrentJobs !== undefined &&
    (typeof maxConcurrentJobs !== "number" || !Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 0)
  ) {
    return { error: `${label}.maxConcurrentJobs must be a non-negative integer` };
  }
  const endpoint: HpcEndpointSettings = {
    id,
    name,
    kind,
    host,
    ...(text("user") ? { user: text("user") } : {}),
    ...(typeof port === "number" ? { port } : {}),
    ...(text("keyPath") ? { keyPath: text("keyPath") } : {}),
    ...(text("defaultPartition") ? { defaultPartition: text("defaultPartition") } : {}),
    ...(text("defaultTime") ? { defaultTime: text("defaultTime") } : {}),
    ...(typeof maxConcurrentJobs === "number" ? { maxConcurrentJobs } : {}),
  };
  return { endpoint };
}

/** Validate and sanitize a whole endpoint list (duplicate ids refused). */
export function validateHpcEndpoints(value: unknown): { endpoints: HpcEndpointSettings[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "hpc.endpoints must be an array" };
  const endpoints: HpcEndpointSettings[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = validateHpcEndpoint(value[index], index);
    if ("error" in parsed) return parsed;
    if (seen.has(parsed.endpoint.id)) return { error: `duplicate endpoint id: ${parsed.endpoint.id}` };
    seen.add(parsed.endpoint.id);
    endpoints.push(parsed.endpoint);
  }
  return { endpoints };
}

/**
 * A server row as it arrives from a `PUT` or a hand-edited file: the patch
 * shape, whose secret maps may carry `null` (a delete marker — meaningful on a
 * PUT, dropped when read back from disk).
 */
type McpServerInput = McpServerPatch;

function validateSecretMap(value: unknown): { map?: Record<string, string | null> } | { error: string } {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return { error: "must be an object of string keys to string values (null deletes a stored key)" };
  const map: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "") return { error: "must not have an empty key" };
    if (entry === null || typeof entry === "string") map[key] = entry;
    else return { error: "values must be strings (null deletes a stored key)" };
  }
  return { map };
}

/**
 * Validate one MCP server row's SHAPE (docs/adr/0026). Unknown fields are a
 * 400, not a silent drop: a typo'd field means the server will not work and
 * the author must hear about it at the door. The secret maps keep their
 * `null` delete markers here — only `mergeMcpServers` resolves them.
 */
export function validateMcpServer(raw: unknown, index: number): { server: McpServerInput } | { error: string } {
  const label = `mcp.servers[${index}]`;
  if (!isPlainObject(raw)) return { error: `${label} must be an object` };
  const serverName = raw.serverName;
  if (typeof serverName !== "string" || !MCP_SERVER_NAME_GRAMMAR.test(serverName)) {
    return { error: `${label}.serverName must match [A-Za-z0-9_-]{1,32}` };
  }
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    return { error: `${label}.transport must be "stdio" or "streamable-http"` };
  }
  const enabled = raw.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { error: `${label}.enabled must be a boolean` };
  }
  if (transport === "stdio") {
    const command = raw.command;
    if (typeof command !== "string" || command === "") {
      return { error: `${label}.command is required for a stdio server` };
    }
    const args = raw.args;
    if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))) {
      return { error: `${label}.args must be an array of strings` };
    }
    const cwd = raw.cwd;
    if (cwd !== undefined && (typeof cwd !== "string" || cwd === "")) {
      return { error: `${label}.cwd must be a non-empty string` };
    }
    const env = validateSecretMap(raw.env);
    if ("error" in env) return { error: `${label}.env ${env.error}` };
    for (const key of Object.keys(raw)) {
      if (!["serverName", "transport", "enabled", "command", "args", "cwd", "env"].includes(key)) {
        return { error: `${label}.${key} is not a stdio server field` };
      }
    }
    return {
      server: {
        serverName,
        transport: "stdio",
        ...(enabled === undefined ? {} : { enabled }),
        command,
        ...(args === undefined ? {} : { args: [...(args as string[])] }),
        ...(cwd === undefined ? {} : { cwd: cwd as string }),
        ...(env.map === undefined ? {} : { env: env.map }),
      },
    };
  }
  const url = raw.url;
  if (typeof url !== "string" || url === "" || !/^https?:\/\//.test(url)) {
    return { error: `${label}.url must be an http(s) URL for a streamable-http server` };
  }
  const headers = validateSecretMap(raw.headers);
  if ("error" in headers) return { error: `${label}.headers ${headers.error}` };
  for (const key of Object.keys(raw)) {
    if (!["serverName", "transport", "enabled", "url", "headers"].includes(key)) {
      return { error: `${label}.${key} is not a streamable-http server field` };
    }
  }
  return {
    server: {
      serverName,
      transport: "streamable-http",
      ...(enabled === undefined ? {} : { enabled }),
      url,
      ...(headers.map === undefined ? {} : { headers: headers.map }),
    },
  };
}

/** Validate a `PUT` server list (duplicate serverNames refused — the plugin's namespace is per registration scope). */
export function validateMcpServerPatches(value: unknown): { servers: McpServerPatch[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "mcp.servers must be an array" };
  const servers: McpServerPatch[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = validateMcpServer(value[index], index);
    if ("error" in parsed) return parsed;
    if (seen.has(parsed.server.serverName)) {
      return { error: `duplicate mcp server name: ${parsed.server.serverName}` };
    }
    seen.add(parsed.server.serverName);
    servers.push(parsed.server);
  }
  return { servers };
}

/**
 * Validate a stored server list read from disk: the same shape rule, with
 * `null` secret values dropped (they only mean something in a `PUT`).
 */
export function validateStoredMcpServers(value: unknown): { servers: McpServerSettings[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "mcp.servers must be an array" };
  const servers: McpServerSettings[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = validateMcpServer(value[index], index);
    if ("error" in parsed) return parsed;
    if (seen.has(parsed.server.serverName)) {
      return { error: `duplicate mcp server name: ${parsed.server.serverName}` };
    }
    seen.add(parsed.server.serverName);
    servers.push(toStoredMcpServer(parsed.server, undefined));
  }
  return { servers };
}

/** Resolve a validated input row against its stored predecessor (per-key secret merge, docs/adr/0026). */
function toStoredMcpServer(
  row: McpServerInput,
  stored: McpServerSettings | undefined,
): McpServerSettings {
  const enabled = row.enabled ?? stored?.enabled ?? true;
  const keepSecrets = stored !== undefined && stored.transport === row.transport;
  if (row.transport === "stdio") {
    const env = mergeSecretMap(keepSecrets ? (stored as McpStdioServerSettings).env : undefined, row.env);
    const server: McpStdioServerSettings = {
      serverName: row.serverName,
      transport: "stdio",
      enabled,
      command: row.command as string,
    };
    if (row.args !== undefined) server.args = row.args;
    if (row.cwd !== undefined) server.cwd = row.cwd;
    if (env !== undefined) server.env = env;
    return server;
  }
  const headers = mergeSecretMap(keepSecrets ? (stored as McpHttpServerSettings).headers : undefined, row.headers);
  const server: McpHttpServerSettings = {
    serverName: row.serverName,
    transport: "streamable-http",
    enabled,
    url: row.url as string,
  };
  if (headers !== undefined) server.headers = headers;
  return server;
}

/**
 * The write-only merge rule: an ABSENT key keeps its stored secret, `null`
 * deletes it, a string replaces it. A patch map that clears every key (or an
 * absent map over no stored secrets) omits the field entirely.
 */
function mergeSecretMap(
  stored: Record<string, string> | undefined,
  patch: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (patch === undefined) return stored ? { ...stored } : undefined;
  const next: Record<string, string> = { ...(stored ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Apply a `PUT` server list to the stored one (docs/adr/0026): the list is a
 * REPLACE like hpc, but each surviving row merges its secret maps key-by-key
 * against the stored row of the same `serverName` — a name that disappears
 * (deleted or renamed) takes its secrets with it.
 */
export function mergeMcpServers(
  current: McpServerSettings[],
  patch: McpServerPatch[],
): McpServerSettings[] {
  const storedByName = new Map(current.map((server) => [server.serverName, server]));
  return patch.map((row) => toStoredMcpServer(row, storedByName.get(row.serverName)));
}

export async function loadSettings(path: string): Promise<RuntimeSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPlainObject(parsed)) throw new Error("settings must be a JSON object");
    // A hand-edited endpoint that cannot work is dropped WITH A WARNING rather
    // than poisoning the file — the same honesty as the rest of the loader.
    let hpc: HpcSettings = { endpoints: [] };
    const hpcRaw = isPlainObject(parsed.hpc) ? parsed.hpc.endpoints : undefined;
    if (Array.isArray(hpcRaw)) {
      const validated = validateHpcEndpoints(hpcRaw);
      if ("error" in validated) {
        console.warn(`[transport-service] ignoring invalid hpc.endpoints in ${path}: ${validated.error}`);
      } else {
        hpc = { endpoints: validated.endpoints };
      }
    }
    // Same rule for MCP servers: a broken row drops the SECTION with a warning,
    // never the file (docs/adr/0026). Note the loader sees plaintext secret
    // values; only `viewOf` masks them.
    let mcp: McpSettings = { servers: [] };
    const mcpRaw = isPlainObject(parsed.mcp) ? parsed.mcp.servers : undefined;
    if (Array.isArray(mcpRaw)) {
      const validated = validateStoredMcpServers(mcpRaw);
      if ("error" in validated) {
        console.warn(`[transport-service] ignoring invalid mcp.servers in ${path}: ${validated.error}`);
      } else {
        mcp = { servers: validated.servers };
      }
    }
    return {
      model: isPlainObject(parsed.model) ? (parsed.model as ModelSettings) : {},
      plugins: isPlainObject(parsed.plugins) ? parsed.plugins : {},
      agent: isPlainObject(parsed.agent) ? parsed.agent : {},
      subagents: isPlainObject(parsed.subagents) ? (parsed.subagents as SubagentSettings) : {},
      thread: isPlainObject(parsed.thread) ? (parsed.thread as ThreadSettings) : {},
      hpc,
      mcp,
    };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      console.warn(`[transport-service] settings unreadable at ${path}`, err);
    }
    return emptySettings();
  }
}

export async function saveSettings(path: string, settings: RuntimeSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique temp name keeps two writers from racing on one scratch file; the
  // rename is atomic either way, but a shared `${path}.tmp` could be clobbered
  // mid-write. `chmod` is explicit so an existing file's mode can never leak in.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export function mergeSettings(current: RuntimeSettings, patch: RuntimeSettingsPatch): RuntimeSettings {
  const model: ModelSettings = { ...current.model };
  if (patch.model) {
    // An empty-string provider/model/endpoint is a CLEAR: `applySettingsToEnv`
    // uses truthiness, so persisting "" would invisibly lose to the ambient env
    // (making `settings > env` inconsistent). `apiKey: ""` stays a value (only
    // `null` clears) because the dialog uses it as a real, distinct input.
    for (const key of ["provider", "model", "endpoint"] as const) {
      const value = patch.model[key];
      if (value === undefined) continue;
      if (value === "") delete model[key];
      else model[key] = value;
    }
    if ("apiKey" in patch.model) {
      if (patch.model.apiKey === null) delete model.apiKey;
      else if (patch.model.apiKey !== undefined) model.apiKey = patch.model.apiKey;
    }
  }
  const subagents: SubagentSettings = { ...(current.subagents ?? {}) };
  if (patch.subagents !== undefined && "visibleWindowHours" in patch.subagents) {
    const value = patch.subagents.visibleWindowHours;
    if (value === null) delete subagents.visibleWindowHours;
    else if (value !== undefined) subagents.visibleWindowHours = value;
  }
  const thread: ThreadSettings = { ...(current.thread ?? {}) };
  if (patch.thread !== undefined && "visibleMessageCount" in patch.thread) {
    const value = patch.thread.visibleMessageCount;
    if (value === null) delete thread.visibleMessageCount;
    else if (value !== undefined) thread.visibleMessageCount = value;
  }
  // The hpc section is a list replace (the whole endpoint inventory), with
  // `null` clearing every endpoint.
  const hpc: HpcSettings = { endpoints: [...(current.hpc?.endpoints ?? [])] };
  if (patch.hpc !== undefined && "endpoints" in patch.hpc) {
    const value = patch.hpc.endpoints;
    if (value === null) hpc.endpoints = [];
    else if (value !== undefined) hpc.endpoints = [...value];
  }
  // The mcp section is also a list replace, but a kept row's secret maps merge
  // per key (absent = keep, null = delete) — the write-only rule (docs/adr/0026).
  const mcp: McpSettings = { servers: [...(current.mcp?.servers ?? [])] };
  if (patch.mcp !== undefined && "servers" in patch.mcp) {
    const value = patch.mcp.servers;
    if (value === null) mcp.servers = [];
    else if (value !== undefined) mcp.servers = mergeMcpServers(current.mcp?.servers ?? [], value);
  }
  return {
    model,
    plugins: patch.plugins ? { ...current.plugins, ...patch.plugins } : current.plugins,
    agent: patch.agent ? { ...current.agent, ...patch.agent } : current.agent,
    subagents,
    thread,
    hpc,
    mcp,
  };
}

/** One stored server as the settings view: secret VALUES are never returned, only their key names. */
export function mcpServerView(server: McpServerSettings): McpServerView {
  if (server.transport === "stdio") {
    const { env, ...rest } = server;
    return { ...rest, envConfigured: Object.keys(env ?? {}) };
  }
  const { headers, ...rest } = server;
  return { ...rest, headersConfigured: Object.keys(headers ?? {}) };
}

export function viewOf(
  settings: RuntimeSettings,
  settingsPath: string,
  env: NodeJS.ProcessEnv,
): RuntimeSettingsView {
  const { apiKey, ...model } = settings.model;
  return {
    model: { ...model, apiKeyConfigured: Boolean(apiKey) },
    plugins: settings.plugins,
    agent: settings.agent,
    subagents: { ...(settings.subagents ?? {}) },
    thread: { ...(settings.thread ?? {}) },
    // An endpoint's key is referenced by PATH — show the endpoints as-is.
    hpc: { endpoints: [...(settings.hpc?.endpoints ?? [])] },
    // An MCP server's secrets are VALUES — show only the configured key names.
    mcp: { servers: (settings.mcp?.servers ?? []).map(mcpServerView) },
    runtime: env.TRANSPORT_RUNTIME ?? "openclaw",
    settingsPath,
  };
}

export function applySettingsToEnv(
  env: NodeJS.ProcessEnv,
  settings: RuntimeSettings,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const { provider, model, endpoint, apiKey } = settings.model;
  if (provider) next.DSH_PROVIDER = provider;
  if (model) next.DSH_MODEL = model;
  if (endpoint) next.SS_MODEL_ENDPOINT = endpoint;
  if (apiKey) next.SS_MODEL_API_KEY = apiKey;
  return next;
}

export function parseSettingsPatch(
  body: unknown,
): { patch: RuntimeSettingsPatch } | { error: string } {
  if (!isPlainObject(body)) return { error: "settings body must be a JSON object" };
  const patch: RuntimeSettingsPatch = {};
  if ("model" in body) {
    const raw = body.model;
    if (!isPlainObject(raw)) return { error: "model must be an object" };
    const model: NonNullable<RuntimeSettingsPatch["model"]> = {};
    for (const key of ["provider", "model", "endpoint"] as const) {
      if (key in raw) {
        const value = raw[key];
        if (typeof value !== "string") return { error: `model.${key} must be a string` };
        model[key] = value;
      }
    }
    if (model.endpoint !== undefined && model.endpoint !== "" && !/^https?:\/\//.test(model.endpoint)) {
      return { error: "model.endpoint must be an http(s) URL" };
    }
    if ("apiKey" in raw) {
      const value = raw.apiKey;
      if (value !== null && typeof value !== "string") {
        return { error: "model.apiKey must be a string or null" };
      }
      model.apiKey = value;
    }
    patch.model = model;
  }
  if ("plugins" in body) {
    if (!isPlainObject(body.plugins)) return { error: "plugins must be an object" };
    patch.plugins = body.plugins;
  }
  if ("agent" in body) {
    if (!isPlainObject(body.agent)) return { error: "agent must be an object" };
    patch.agent = body.agent;
  }
  if ("subagents" in body) {
    if (!isPlainObject(body.subagents)) return { error: "subagents must be an object" };
    const sub: SubagentSettingsPatch = {};
    if ("visibleWindowHours" in body.subagents) {
      const value = body.subagents.visibleWindowHours;
      if (value === null) sub.visibleWindowHours = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 720)
        sub.visibleWindowHours = value;
      else return { error: "subagents.visibleWindowHours must be an integer between 1 and 720" };
    }
    patch.subagents = sub;
  }
  if ("thread" in body) {
    if (!isPlainObject(body.thread)) return { error: "thread must be an object" };
    const thr: ThreadSettingsPatch = {};
    if ("visibleMessageCount" in body.thread) {
      const value = body.thread.visibleMessageCount;
      if (value === null) thr.visibleMessageCount = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 10 && value <= 100)
        thr.visibleMessageCount = value;
      else return { error: "thread.visibleMessageCount must be an integer between 10 and 100" };
    }
    patch.thread = thr;
  }
  if ("hpc" in body) {
    if (!isPlainObject(body.hpc)) return { error: "hpc must be an object" };
    const hpc: HpcSettingsPatch = {};
    if ("endpoints" in body.hpc) {
      const value = body.hpc.endpoints;
      if (value === null) {
        hpc.endpoints = null;
      } else {
        const validated = validateHpcEndpoints(value);
        if ("error" in validated) return { error: validated.error };
        hpc.endpoints = validated.endpoints;
      }
    }
    patch.hpc = hpc;
  }
  if ("mcp" in body) {
    if (!isPlainObject(body.mcp)) return { error: "mcp must be an object" };
    const mcp: McpSettingsPatch = {};
    if ("servers" in body.mcp) {
      const value = body.mcp.servers;
      if (value === null) {
        mcp.servers = null;
      } else {
        const validated = validateMcpServerPatches(value);
        if ("error" in validated) return { error: validated.error };
        mcp.servers = validated.servers;
      }
    }
    patch.mcp = mcp;
  }
  return { patch };
}
