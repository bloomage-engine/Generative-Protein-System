import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface DshStat {
  isFile(): boolean;
}

export function detectDsh(input: {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  access?: (path: string) => void;
  stat?: (path: string) => DshStat;
} = {}): string | null {
  const platform = input.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const pathEnv = input.pathEnv ?? process.env.PATH ?? "";
  const access = input.access ?? ((p: string) => accessSync(p, constants.X_OK));
  const stat = input.stat ?? ((p: string) => statSync(p));
  const names = platform === "win32" ? ["dsh.exe", "dsh.cmd", "dsh.bat"] : ["dsh"];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (!stat(candidate).isFile()) continue;
        if (platform !== "win32") access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
