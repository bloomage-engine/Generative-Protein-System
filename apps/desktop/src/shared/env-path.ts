import { delimiter, join } from "node:path";

export function augmentPath(pathEnv: string | undefined, homeDir: string, platform?: NodeJS.Platform): string {
  const current = pathEnv ?? "";
  if ((platform ?? process.platform) === "win32") return current;
  const parts = current.split(delimiter).filter(Boolean);
  const seen = new Set(parts);
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", join(homeDir, ".local", "bin"), join(homeDir, "bin")]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(delimiter);
}
