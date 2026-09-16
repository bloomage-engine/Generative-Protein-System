import type { DesktopPaths } from "./paths.js";

export interface DesktopConfig {
  provider?: string;
  model?: string;
  vars?: Record<string, string>;
}

export function parseConfigEnv(text: string): DesktopConfig {
  const vars: Record<string, string> = {};
  let provider: string | undefined;
  let model: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "DSH_PROVIDER") provider = value;
    else if (key === "DSH_MODEL") model = value;
    else vars[key] = value;
  }
  const config: DesktopConfig = {};
  if (provider !== undefined) config.provider = provider;
  if (model !== undefined) config.model = model;
  if (Object.keys(vars).length > 0) config.vars = vars;
  return config;
}

export function serializeConfigEnv(config: DesktopConfig): string {
  const lines: string[] = [];
  if (config.provider !== undefined) lines.push(`DSH_PROVIDER=${config.provider}`);
  if (config.model !== undefined) lines.push(`DSH_MODEL=${config.model}`);
  for (const key of Object.keys(config.vars ?? {}).sort()) lines.push(`${key}=${config.vars![key]}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function buildChildEnv(input: {
  base: NodeJS.ProcessEnv;
  config: DesktopConfig;
  paths: DesktopPaths;
}): NodeJS.ProcessEnv {
  const { base, config, paths } = input;
  const env: NodeJS.ProcessEnv = { ...base, ...(config.vars ?? {}) };
  delete env.SS_ENTERPRISE_MODULE;
  env.NODE_ENV = "production";
  env.TRANSPORT_RUNTIME = "dsh";
  env.PROJECT_ROOT = paths.projectRoot;
  env.RECORD_STORE_PATH = paths.recordStorePath;
  env.DSH_HOME = paths.dshHome;
  env.DSH_TRANSCRIPT_DIR = paths.transcriptDir;
  env.DSH_DEFAULT_SESSION = "science-studio";
  if (config.provider !== undefined) env.DSH_PROVIDER = config.provider;
  if (config.model !== undefined) env.DSH_MODEL = config.model;
  return env;
}
