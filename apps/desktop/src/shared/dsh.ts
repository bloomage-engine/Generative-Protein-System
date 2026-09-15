import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function detectDsh(input: {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  access?: (path: string) => void;
} = {}): string | null {
  const pathEnv = input.pathEnv ?? process.env.PATH ?? "";
  const access = input.access ?? ((p: string) => accessSync(p, constants.X_OK));
  const names = (input.platform ?? process.platform) === "win32" ? ["dsh.exe", "dsh.cmd", "dsh.bat"] : ["dsh"];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
