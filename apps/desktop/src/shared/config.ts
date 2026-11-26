import type { DesktopPaths } from "./paths.js";

export interface DesktopConfig {
  vars?: Record<string, string>;
}

export function parseConfigEnv(text: string): DesktopConfig {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(vars).length > 0 ? { vars } : {};
}

export function serializeConfigEnv(config: DesktopConfig): string {
  const lines = Object.keys(config.vars ?? {})
    .sort()
    .map((key) => `${key}=${config.vars![key]}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function buildChildEnv(input: {
  base: NodeJS.ProcessEnv;
  config: DesktopConfig;
  paths: DesktopPaths;
}): NodeJS.ProcessEnv {
  const { base, config, paths } = input;
  const env: NodeJS.ProcessEnv = { ...base, ...(config.vars ?? {}) };
  delete env.GPS_ENTERPRISE_MODULE;
  env.NODE_ENV = "production";
  env.TRANSPORT_RUNTIME = "dsh";
  env.PROJECT_ROOT = paths.projectRoot;
  env.RECORD_STORE_PATH = paths.recordStorePath;
  env.DSH_HOME = paths.dshHome;
  env.DSH_TRANSCRIPT_DIR = paths.transcriptDir;
  env.DSH_DEFAULT_SESSION = "gps";
  env.GPS_SETTINGS_PATH = paths.settingsPath;
  return env;
}
