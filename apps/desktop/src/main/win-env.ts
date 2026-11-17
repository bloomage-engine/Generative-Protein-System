import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  expandWindowsEnv,
  findGitBinary,
  mergePathLists,
  parseRegPathOutput,
} from "../shared/git-discovery.js";

const PERSISTED_PATH_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
] as const;

function queryPersistedPath(key: string): string | null {
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  try {
    const output = execFileSync(reg, ["query", key, "/v", "Path"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return parseRegPathOutput(output);
  } catch {
    return null;
  }
}

/** The user and machine PATH values as stored in the registry. */
export function readPersistedWindowsPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  for (const key of PERSISTED_PATH_KEYS) {
    const raw = queryPersistedPath(key);
    if (raw) paths.push(expandWindowsEnv(raw, env));
  }
  return paths;
}

/**
 * A process gets a PATH snapshot at launch, so a GUI started before Git was
 * added to the environment (or with a truncated PATH) cannot see it. Read the
 * persisted values, find `git.exe`, and let the caller pin `GIT_BINARY`.
 */
export function resolveWindowsGit(input: {
  basePath?: string;
  env: NodeJS.ProcessEnv;
  persistedPaths?: string[];
  exists?: (candidate: string) => boolean;
}): { path: string; git: string | null } {
  const persisted = input.persistedPaths ?? readPersistedWindowsPath(input.env);
  const entries = mergePathLists([input.basePath, ...persisted], "win32");
  const exists = input.exists ?? existsSync;
  const git = findGitBinary(entries, "win32", exists, input.env);
  return { path: entries.join(";"), git };
}
