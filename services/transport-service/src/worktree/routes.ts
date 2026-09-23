/**
 * The per-Project git worktree surface (docs/adr/0025).
 *
 * A Project's Workspace IS a git repository, and each Worktree is a linked
 * checkout under `.worktrees/<id>/` on its own branch; the Project root itself is
 * the reserved `main` worktree. The repository is initialized LAZILY — the first
 * create is what runs `git init` and writes the first commit — so listing a
 * Worktree never touches the disk (the plan's invariant: `GET /api/worktrees`
 * must not create a repository).
 *
 * The worktree records are authoritative in the record layer; the git checkout
 * is an implementation detail derived from the id (`worktreeRelPath`). Every
 * route reads the request's Project claim through `ProjectScopes.claim` and so
 * speaks the same dialect as the rest of the service.
 */
import type { FastifyInstance } from "fastify";
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_WORKTREE_ID, type Id, type RecordStore } from "@science-studio/record";
import type { EnvironmentProvider, Principal } from "@science-studio/transport";
import type { RecordDirectory } from "../directory.js";
import type { ProjectScopes } from "../project-scope.js";
import {
  ensureRepo,
  GitError,
  isRepo,
  listWorktrees,
  worktreeAdd,
  worktreeRemove,
  type GitRunner,
} from "./git.js";
import { worktreeRelPath } from "./paths.js";

export interface WorktreeRouteDeps {
  scope: ProjectScopes;
  directory: RecordDirectory;
  records: RecordStore;
  environments: EnvironmentProvider;
  git: GitRunner;
  /** The host-side parent of every Project directory; absent = no file surface. */
  projectRoot?: string;
}

export function registerWorktreeRoutes(app: FastifyInstance, deps: WorktreeRouteDeps): void {
  const { scope, directory, records, environments, git, projectRoot } = deps;

  const projectDir = (projectId: string): string | null =>
    projectRoot ? join(projectRoot, projectId) : null;
  const worktreeDir = (projectId: string, id: string): string | null => {
    const project = projectDir(projectId);
    return project ? join(project, worktreeRelPath(id)) : null;
  };

  // -- List a Project's worktrees -------------------------------------------
  app.get("/api/worktrees", async (request) => {
    const claim = await scope.claim(request);
    // `main` is always listed: the Project root IS its main worktree, even
    // before any repository exists on disk (docs/adr/0025).
    await directory.ensureWorktree(claim.projectId);
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "1";
    const rows = await directory.listWorktrees(claim.projectId, { includeArchived });

    // Decorate with on-disk state only when the Project actually has a
    // repository — a listing must never create one.
    const dir = projectDir(claim.projectId);
    const branchByPath = dir && (await isRepo(git, dir)) ? await branchMap(git, dir) : null;

    const worktrees = await Promise.all(
      rows.map(async (worktree) => {
        if (!dir) return worktree;
        const path = worktreeDir(claim.projectId, worktree.id)!;
        return {
          ...worktree,
          path,
          exists: await pathExists(path),
          ...(branchByPath ? { onDiskBranch: branchByPath.get(path) ?? null } : {}),
        };
      }),
    );
    return { worktrees, defaultWorktreeId: DEFAULT_WORKTREE_ID };
  });

  // -- Create a worktree (initializes the repository lazily) ----------------
  app.post("/api/worktrees", async (request, reply) => {
    const claim = await scope.claim(request);
    const body = (request.body ?? {}) as { name?: unknown; branch?: unknown; base?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!(await records.getProject(claim.projectId))) {
      return reply.code(404).send({ error: `project not found: ${claim.projectId}` });
    }
    const dir = projectDir(claim.projectId);
    if (!dir) {
      return reply.code(503).send({ error: "worktrees require a configured PROJECT_ROOT" });
    }
    // The Project Workspace may not exist yet (a workspace is created lazily);
    // `git init` below needs its cwd.
    await mkdir(dir, { recursive: true });
    await ensureRepo(git, dir);

    const id = await directory.mintWorktreeId(claim.projectId, name);
    const branch = (typeof body.branch === "string" && body.branch.trim()) || id;
    const base = (typeof body.base === "string" && body.base.trim()) || "main";
    const path = worktreeDir(claim.projectId, id)!;

    try {
      await worktreeAdd(git, { repoDir: dir, path, branch, base, createBranch: true });
    } catch (err) {
      if (err instanceof GitError) {
        // A branch checked out elsewhere / an existing path is a conflict the
        // caller can resolve; anything else is an upstream git failure.
        const conflict = /already checked out|already exists|is already used/i.test(err.stderr);
        return reply.code(conflict ? 409 : 502).send({ error: err.stderr || err.message });
      }
      throw err;
    }

    try {
      const worktree = await directory.addWorktree(claim.projectId, { id, name, branch });
      return reply.code(201).send({ worktree });
    } catch (err) {
      // The record is authoritative: a failed row write must not leave an
      // orphaned checkout behind.
      await worktreeRemove(git, { repoDir: dir, path, force: true }).catch((cleanupErr) => {
        console.error(`[transport-service] worktree cleanup failed for "${id}"`, cleanupErr);
      });
      throw err;
    }
  });

  // -- Rename a worktree -----------------------------------------------------
  app.post("/api/worktrees/:id/rename", async (request, reply) => {
    const claim = await scope.claim(request);
    const { id } = request.params as { id: string };
    if (id === DEFAULT_WORKTREE_ID) {
      return reply.code(403).send({ error: "the main worktree cannot be renamed" });
    }
    const body = (request.body ?? {}) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!(await directory.findWorktree(claim.projectId, id))) {
      return reply.code(404).send({ error: `worktree not found: ${id}` });
    }
    return { worktree: await directory.renameWorktree(claim.projectId, id, name) };
  });

  // -- Archive / unarchive (reversible) -------------------------------------
  app.post("/api/worktrees/:id/archive", async (request, reply) => {
    const claim = await scope.claim(request);
    const { id } = request.params as { id: string };
    if (id === DEFAULT_WORKTREE_ID) {
      return reply.code(403).send({ error: "the main worktree cannot be archived" });
    }
    if (!(await directory.findWorktree(claim.projectId, id))) {
      return reply.code(404).send({ error: `worktree not found: ${id}` });
    }
    // An archived worktree's adapter/workspace is no longer reachable, so drop
    // its cached environment (best-effort — the record change is the truth).
    await releaseEnvironment(environments, claim.principal, claim.projectId, id);
    return { worktree: await directory.archiveWorktree(claim.projectId, id) };
  });

  app.post("/api/worktrees/:id/unarchive", async (request, reply) => {
    const claim = await scope.claim(request);
    const { id } = request.params as { id: string };
    if (id === DEFAULT_WORKTREE_ID) {
      return reply.code(403).send({ error: "the main worktree cannot be unarchived" });
    }
    if (!(await directory.findWorktree(claim.projectId, id))) {
      return reply.code(404).send({ error: `worktree not found: ${id}` });
    }
    return { worktree: await directory.unarchiveWorktree(claim.projectId, id) };
  });

  // -- Delete (irreversible; the checkout is removed) -----------------------
  app.post("/api/worktrees/:id/delete", async (request, reply) => {
    const claim = await scope.claim(request);
    const { id } = request.params as { id: string };
    if (id === DEFAULT_WORKTREE_ID) {
      return reply.code(403).send({ error: "the main worktree cannot be deleted" });
    }
    if (!(await directory.findWorktree(claim.projectId, id))) {
      return reply.code(404).send({ error: `worktree not found: ${id}` });
    }
    await releaseEnvironment(environments, claim.principal, claim.projectId, id);

    const dir = projectDir(claim.projectId);
    const path = worktreeDir(claim.projectId, id);
    if (dir && path) {
      // Deregister the linked checkout; if git refuses (or there was never a
      // repo) the directory move below still removes it by hand.
      await worktreeRemove(git, { repoDir: dir, path, force: true }).catch((err) => {
        console.error(`[transport-service] git worktree remove failed for "${id}"`, err);
      });
      if (await pathExists(path)) {
        await moveToRecycle(path).catch((err) => {
          console.error(`[transport-service] recycling worktree "${id}" failed`, err);
        });
      }
    }

    await directory.deleteWorktree(claim.projectId, id);
    return { ok: true };
  });
}

/** A path→branch map from `git worktree list --porcelain`. */
async function branchMap(git: GitRunner, repoDir: string): Promise<Map<string, string | null>> {
  const entries = await listWorktrees(git, repoDir);
  return new Map(entries.map((entry) => [entry.path, entry.branch]));
}

/** `stat` that reports a missing path as `false` instead of throwing. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort release of a worktree's cached environment; never fails a route. */
async function releaseEnvironment(
  environments: EnvironmentProvider,
  principal: Principal,
  projectId: Id,
  worktreeId: Id,
): Promise<void> {
  try {
    await environments.release?.(principal, projectId, worktreeId);
  } catch (err) {
    console.error(
      `[transport-service] releasing project "${projectId}" worktree "${worktreeId}" failed`,
      err,
    );
  }
}

/**
 * Move `target` into `<parent>/.recycle/<name>-<ts>/` — the same shape as
 * `FsWorkspace.recycle` (docs/adr/0014): same-parent, so a rename is a cheap
 * atomic move and the bytes stay recoverable by hand.
 */
async function moveToRecycle(target: string): Promise<void> {
  const bin = join(dirname(target), ".recycle");
  await mkdir(bin, { recursive: true });
  const dest = join(bin, `${basename(target)}-${Date.now().toString(36)}`);
  try {
    await rename(target, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
