/**
 * The deployment settings file: where the workbench's Model / Plugins / Agent
 * dialog persists. Deployment configuration, NOT record rows — the record stays
 * authoritative for Project/Session identity (docs/adr/0002, 0007).
 *
 * The key is stored plaintext (a single-user local install has no secret
 * store) but is write-only over HTTP and never logged.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ModelSettings,
  RuntimeSettings,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "@science-studio/transport";

export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SS_SETTINGS_PATH) return env.SS_SETTINGS_PATH;
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "science-studio", "settings.json");
}

export function emptySettings(): RuntimeSettings {
  return { model: {}, plugins: {}, agent: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadSettings(path: string): Promise<RuntimeSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPlainObject(parsed)) throw new Error("settings must be a JSON object");
    return {
      model: isPlainObject(parsed.model) ? (parsed.model as ModelSettings) : {},
      plugins: isPlainObject(parsed.plugins) ? parsed.plugins : {},
      agent: isPlainObject(parsed.agent) ? parsed.agent : {},
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
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export function mergeSettings(current: RuntimeSettings, patch: RuntimeSettingsPatch): RuntimeSettings {
  const model: ModelSettings = { ...current.model };
  if (patch.model) {
    if (patch.model.provider !== undefined) model.provider = patch.model.provider;
    if (patch.model.model !== undefined) model.model = patch.model.model;
    if (patch.model.endpoint !== undefined) model.endpoint = patch.model.endpoint;
    if ("apiKey" in patch.model) {
      if (patch.model.apiKey === null) delete model.apiKey;
      else if (patch.model.apiKey !== undefined) model.apiKey = patch.model.apiKey;
    }
  }
  return {
    model,
    plugins: patch.plugins ? { ...current.plugins, ...patch.plugins } : current.plugins,
    agent: patch.agent ? { ...current.agent, ...patch.agent } : current.agent,
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
  return { patch };
}
