import { posix, win32 } from "node:path";

/** The platform whose path grammar and delimiter we should use. */
export type GitPathPlatform = NodeJS.Platform;

function pathApi(platform: GitPathPlatform): typeof win32 | typeof posix {
  return platform === "win32" ? win32 : posix;
}

function pathKey(value: string, platform: GitPathPlatform): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Split a PATH value, trim blank entries, and drop duplicates. */
export function splitPathList(value: string | undefined, platform: GitPathPlatform): string[] {
  const path = pathApi(platform);
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of (value ?? "").split(path.delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (entry === "") continue;
    const key = pathKey(entry, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/** Merge PATH lists (current process, persisted user, persisted machine). */
export function mergePathLists(values: readonly (string | undefined)[], platform: GitPathPlatform): string[] {
  return splitPathList(values.filter((value): value is string => value !== undefined).join(pathApi(platform).delimiter), platform);
}

/** Prepend one directory to a PATH value without creating a duplicate. */
export function prependPathEntry(entry: string, value: string | undefined, platform: GitPathPlatform): string {
  return mergePathLists([entry, value], platform).join(pathApi(platform).delimiter);
}

/** Expand Windows `%VAR%` references using the supplied environment. */
export function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  const byName = new Map(Object.entries(env).map(([key, val]) => [key.toLowerCase(), val ?? ""]));
  return value.replace(/%([^%]+)%/g, (match, name: string) => byName.get(name.toLowerCase()) ?? match);
}

/** Extract the `Path` value from `reg.exe query ... /v Path` output. */
export function parseRegPathOutput(output: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return match?.[1]?.trim() ?? null;
}

/**
 * Candidate `git.exe` locations for a Windows PATH. Besides each PATH entry
 * itself, inspect its parent for the common portable layout `Git\cmd` beside a
 * separate `Git LFS` directory, then fall back to standard install roots.
 */
export function windowsGitCandidates(entries: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (!candidates.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate);
    }
  };
  const addGitRoot = (root: string): void => {
    add(win32.join(root, "cmd", "git.exe"));
    add(win32.join(root, "bin", "git.exe"));
    add(win32.join(root, "mingw64", "bin", "git.exe"));
  };

  for (const entry of entries) {
    add(win32.join(entry, "git.exe"));
    addGitRoot(entry);
    addGitRoot(win32.join(win32.dirname(entry), "Git"));
  }

  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  addGitRoot(win32.join(programFiles, "Git"));
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  addGitRoot(win32.join(programFilesX86, "Git"));
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) addGitRoot(win32.join(localAppData, "Programs", "Git"));
  const userProfile = env.USERPROFILE;
  if (userProfile) add(win32.join(userProfile, "scoop", "apps", "git", "current", "cmd", "git.exe"));
  const programData = env.ProgramData ?? "C:\\ProgramData";
  add(win32.join(programData, "chocolatey", "bin", "git.exe"));
  const gitLfsPath = env.GIT_LFS_PATH;
  if (gitLfsPath) addGitRoot(win32.join(win32.dirname(gitLfsPath), "Git"));

  return candidates;
}

/** Find the first existing `git` executable for the platform. */
export function findGitBinary(
  entries: readonly string[],
  platform: GitPathPlatform,
  exists: (candidate: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates =
    platform === "win32" ? windowsGitCandidates(entries, env) : entries.map((entry) => posix.join(entry, "git"));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}
