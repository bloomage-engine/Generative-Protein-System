import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitRunner,
  currentBranch,
  ensureRepo,
  GitError,
  isRepo,
  listWorktrees,
  worktreeAdd,
  worktreeRemove,
} from "../src/worktree/git.js";

const git = createGitRunner();

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ss-git-"));
}

test("ensureRepo initializes main, gitignores and commits, idempotently", async () => {
  const dir = await tmp();
  try {
    assert.equal(await isRepo(git, dir), false);
    assert.equal(await ensureRepo(git, dir), true);
    assert.equal(await isRepo(git, dir), true);
    assert.equal(await currentBranch(git, dir), "main");
    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(ignore, /\.worktrees\//);
    assert.match(ignore, /\.science-studio\//);
    assert.equal(await ensureRepo(git, dir), false); // already a repo
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktreeAdd creates a linked checkout and worktreeRemove clears it", async () => {
  const dir = await tmp();
  try {
    await ensureRepo(git, dir);
    const path = join(dir, ".worktrees", "exp-a");
    await worktreeAdd(git, { repoDir: dir, path, branch: "exp-a", base: "main", createBranch: true });
    assert.equal(await currentBranch(git, path), "exp-a");
    const listed = await listWorktrees(git, dir);
    assert.ok(listed.some((w) => w.branch === "exp-a"));
    await worktreeRemove(git, { repoDir: dir, path, force: true });
    await assert.rejects(() => stat(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktreeAdd on a branch already checked out throws GitError with stderr", async () => {
  const dir = await tmp();
  try {
    await ensureRepo(git, dir);
    await worktreeAdd(git, { repoDir: dir, path: join(dir, ".worktrees", "same"), branch: "same", base: "main", createBranch: true });
    await assert.rejects(
      () => worktreeAdd(git, { repoDir: dir, path: join(dir, ".worktrees", "same-2"), branch: "same", base: "main", createBranch: false }),
      (err: unknown) => err instanceof GitError && /already checked out|already used/i.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
