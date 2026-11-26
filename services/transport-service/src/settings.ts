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
  ModelSettings,
  RuntimeSettings,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
  SubagentSettings,
  SubagentSettingsPatch,
  ThreadSettings,
  ThreadSettingsPatch,
} from "@science-studio/transport";
import { isSafeRemotePath, isValidEndpointId } from "@science-studio/hpc";
import { parseMcpSettings } from "./mcp/codec.js";

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
    const mcp = parseMcpSettings(parsed.mcp);
    for (const error of mcp.errors) {
      console.warn(`[transport-service] ignoring invalid MCP server in ${path}: ${error}`);
    }
    return {
      model: isPlainObject(parsed.model) ? (parsed.model as ModelSettings) : {},
      plugins: isPlainObject(parsed.plugins) ? parsed.plugins : {},
      agent: isPlainObject(parsed.agent) ? parsed.agent : {},
      subagents: isPlainObject(parsed.subagents) ? (parsed.subagents as SubagentSettings) : {},
      thread: isPlainObject(parsed.thread) ? (parsed.thread as ThreadSettings) : {},
      hpc,
      mcp: mcp.settings,
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
  return {
    model,
    plugins: patch.plugins ? { ...current.plugins, ...patch.plugins } : current.plugins,
    agent: patch.agent ? { ...current.agent, ...patch.agent } : current.agent,
    subagents,
    thread,
    hpc,
    mcp: current.mcp ?? { servers: [] },
  };
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
  // The full enabled catalog rides the dsh binding; the dsh adapter filters it
  // to the active Project and passes only that slice to its child. The name
  // contains SECRET so the harness's subprocess scrub keeps it out of ordinary
  // tool envs (docs/adr/0026).
  const enabled = (settings.mcp?.servers ?? []).filter((server) => server.enabled);
  if (enabled.length > 0) next.SS_MCP_SECRET_CONFIG = JSON.stringify(enabled);
  else delete next.SS_MCP_SECRET_CONFIG;
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
  return { patch };
}
