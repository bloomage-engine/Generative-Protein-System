export interface ElectronLaunchOptions {
  flags: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the Electron launch environment without shell-specific syntax.
 *
 * `dev` points the shell at the already-running web dev server; the packaged
 * path leaves `DESKTOP_DEV_URL` unset so the desktop host boots its own servers.
 * `--no-sandbox` is a Linux dev-box workaround (the setuid helper is often not
 * root-owned there), never a Windows/macOS default; an explicit
 * `DESKTOP_ELECTRON_FLAGS` always wins, including an empty value.
 */
export function electronLaunchOptions(input: {
  dev: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): ElectronLaunchOptions {
  const platform = input.platform ?? process.platform;
  const env = { ...(input.env ?? process.env) };
  if (input.dev && !env.DESKTOP_DEV_URL) {
    env.DESKTOP_DEV_URL = "http://localhost:3000";
  }
  const raw = env.DESKTOP_ELECTRON_FLAGS ?? (platform === "linux" ? "--no-sandbox" : "");
  return { flags: raw.split(/\s+/).filter(Boolean), env };
}
