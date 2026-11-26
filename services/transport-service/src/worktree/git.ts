import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult>;
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * The system `git` binary could not be spawned (missing from PATH, or not
 * executable). Distinct from {@link GitError} — git ran and failed — because the
 * deployment cannot do git AT ALL: the worktree routes answer 503 rather than a
 * 500 (docs/adr/0025).
 */
export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUnavailableError";
  }
}

/** The runner's `{code:-1, stderr}` contract for a spawn failure (not a git exit). */
function spawnFailed(result: GitResult): boolean {
  return (
    result.code === -1 &&
    /ENOENT|EACCES|not found|no such file|not recognized|cannot find|permission denied/i.test(
      result.stderr,
    )
  );
}

function gitUnavailable(result: GitResult): GitUnavailableError {
  return new GitUnavailableError(
    `git is not available: ${result.stderr.trim() || "the system git binary could not be spawned"}`,
  );
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const GITIGNORE_ENTRIES = [".worktrees/", ".gps/"] as const;
const COMMITTER = ["-c", "user.name=Generative Protein System", "-c", "user.email=gps@localhost"];

export function createGitRunner(opts: { gitBin?: string } = {}): GitRunner {
  const gitBin = opts.gitBin ?? process.env.GIT_BINARY ?? "git";
  return {
    run(args, runOpts = {}) {
      return new Promise((resolve) => {
        const child = spawn(gitBin, args, { cwd: runOpts.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          resolve({ code: -1, stdout, stderr: `${stderr}\ngit timed out after ${timeoutMs}ms`.trim() });
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: err.message });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

/**
 * True when `dir` is inside a git work tree. A missing/unspawnable binary is NOT
 * "not a repo" — it raises {@link GitUnavailableError} so a caller cannot mistake
 * an unavailable git for an ordinary no-repo answer.
 */
export async function isRepo(git: GitRunner, dir: string): Promise<boolean> {
  const result = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  if (spawnFailed(result)) throw gitUnavailable(result);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function ensureGitignore(dir: string): Promise<void> {
  const file = join(dir, ".gitignore");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    current = "";
  }
  const lines = new Set(current.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
}

async function must(git: GitRunner, args: string[], cwd: string): Promise<string> {
  const result = await git.run(args, { cwd });
  if (spawnFailed(result)) throw gitUnavailable(result);
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed`, result.stderr.trim(), result.code);
  }
  return result.stdout;
}

/** Lazily initialize `dir` as a git repo with a first commit. Idempotent. */
export async function ensureRepo(git: GitRunner, dir: string): Promise<boolean> {
  if (await isRepo(git, dir)) return false;
  await must(git, ["init", "-b", "main"], dir);
  await ensureGitignore(dir);
  await must(git, ["add", "-A"], dir);
  await must(git, [...COMMITTER, "commit", "-m", "Initialize project workspace"], dir);
  return true;
}

export async function currentBranch(git: GitRunner, dir: string): Promise<string> {
  return (await must(git, ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
}

export async function worktreeAdd(
  git: GitRunner,
  opts: { repoDir: string; path: string; branch: string; base: string; createBranch: boolean },
): Promise<void> {
  const args = opts.createBranch
    ? ["worktree", "add", "-b", opts.branch, opts.path, opts.base]
    : ["worktree", "add", opts.path, opts.branch];
  await must(git, args, opts.repoDir);
}

export async function worktreeRemove(
  git: GitRunner,
  opts: { repoDir: string; path: string; force: boolean },
): Promise<void> {
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), opts.path];
  await must(git, args, opts.repoDir);
}

/**
 * Delete a worktree's branch (best-effort): the branch is always created by
 * `worktreeAdd -b`, so removing it on teardown is safe and lets the same name
 * be recreated later. A branch the runtimes never created (or already gone) is
 * not an error.
 */
export async function branchDelete(
  git: GitRunner,
  opts: { repoDir: string; branch: string },
): Promise<void> {
  const result = await git.run(["branch", "-D", opts.branch], { cwd: opts.repoDir });
  if (spawnFailed(result)) throw gitUnavailable(result);
  if (result.code !== 0 && !/not found/i.test(result.stderr)) {
    throw new GitError("git branch -D failed", result.stderr.trim(), result.code);
  }
}

/** Parse `git worktree list --porcelain` into path/branch pairs. */
export async function listWorktrees(
  git: GitRunner,
  repoDir: string,
): Promise<{ path: string; branch: string | null }[]> {
  const out = await must(git, ["worktree", "list", "--porcelain"], repoDir);
  const result: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) result.push(current);
  return result;
}
