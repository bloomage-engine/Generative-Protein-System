/**
 * The record-backed Project / Session / Run directory.
 *
 * Science Studio owns the record (docs/adr/0002): the Project and Session
 * identity a run is driven with must come from the record layer rather than
 * fabricated constants. Sessions are created EXPLICITLY under a Project
 * (docs/adr/0007) — `POST /api/projects/:id/sessions` — and the transport route
 * only RESOLVES a claimed runtime session key to an existing Session, refusing an
 * unknown one. A Project is archived, never deleted.
 *
 * Project ids are filesystem-safe slugs because a Project's id names its
 * workspace directory (`<PROJECT_ROOT>/<projectId>/`, docs/adr/0006).
 */
import type { Id, Project, RecordStore, Run, Session, Worktree } from "@science-studio/record";
import { DEFAULT_WORKTREE_ID, MAIN_BRANCH } from "@science-studio/record";

export interface RecordDefaults {
  projectId: Id;
  projectName: string;
  agentId: Id;
}

export const DEFAULT_RECORD_DEFAULTS: RecordDefaults = {
  projectId: "project-default",
  projectName: "Default project",
  agentId: "main",
};

/** Thrown when a Project has no Worktree with the given id. */
export class WorktreeNotFoundError extends Error {
  constructor(
    readonly projectId: Id,
    readonly worktreeId: Id,
  ) {
    super(`worktree not found: ${worktreeId}`);
    this.name = "WorktreeNotFoundError";
  }
}

export interface RecordDirectory {
  /** Create a Project; its id is a slug of `name` (unique-suffixed). */
  createProject(name: string): Promise<Project>;
  listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
  /** Rename a Project (its id, and thus its workspace directory, is immutable). */
  renameProject(id: Id, name: string): Promise<Project>;
  archiveProject(id: Id): Promise<Project>;
  /** Clear a Project's archived flag. */
  unarchiveProject(id: Id): Promise<Project>;
  /**
   * Remove a Project's record (cascading its Sessions and their Runs). The
   * caller recycles the Project Workspace separately, before or after this.
   */
  deleteProject(id: Id): Promise<void>;

  /**
   * Ensure a Project's reserved `main` Worktree row (id/name/branch `main`).
   * Idempotent: the Project root IS the `main` worktree (docs/adr/0025).
   */
  ensureWorktree(projectId: Id): Promise<Worktree>;
  findWorktree(projectId: Id, id: Id): Promise<Worktree | null>;
  /** Like `findWorktree`, but throws `WorktreeNotFoundError` instead of null. */
  requireWorktree(projectId: Id, id: Id): Promise<Worktree>;
  /** Mint a filesystem-safe, Project-unique Worktree id from a display name. */
  mintWorktreeId(projectId: Id, name: string): Promise<Id>;
  addWorktree(projectId: Id, input: { id: Id; name: string; branch: string }): Promise<Worktree>;
  listWorktrees(projectId: Id, opts?: { includeArchived?: boolean }): Promise<Worktree[]>;
  /** Rename a Worktree (its id and branch are immutable). */
  renameWorktree(projectId: Id, id: Id, name: string): Promise<Worktree>;
  archiveWorktree(projectId: Id, id: Id): Promise<Worktree>;
  /** Clear a Worktree's archived flag. */
  unarchiveWorktree(projectId: Id, id: Id): Promise<Worktree>;
  /** Remove a Worktree's record (cascading its Sessions and their Runs). */
  deleteWorktree(projectId: Id, id: Id): Promise<void>;

  createSession(
    projectId: Id,
    opts?: { agentId?: Id; title?: string; worktreeId?: Id },
  ): Promise<Session>;
  listSessions(projectId: Id, opts?: { includeArchived?: boolean }): Promise<Session[]>;
  /** Rename a Session (its `title`). */
  renameSession(id: Id, title: string): Promise<Session>;
  archiveSession(id: Id): Promise<Session>;
  unarchiveSession(id: Id): Promise<Session>;
  /** Remove a Session's record (cascading its Runs). */
  deleteSession(id: Id): Promise<void>;
  /** The Session a canonical runtime session key belongs to, or null. */
  resolveSession(sessionKey: string): Promise<Session | null>;
  /**
   * Find — or lazily mint — the Session a canonical session key names under a
   * Project, creating the Project row too if it is missing. Mount probes and
   * clients that name no Project must keep converging (see the Phase 2.6 note in
   * docs/design/implementation-plan.md), so the transport route resolves through
   * here rather than refusing an unknown key.
   */
  resolveOrCreateSession(projectId: Id, sessionKey: Id, worktreeId?: Id): Promise<Session>;
  listRuns(projectId: Id): Promise<Run[]>;
}

export interface RecordDirectoryOptions {
  store: RecordStore;
  defaults?: RecordDefaults;
  now?: () => string;
  /** Id factory; injectable so tests are deterministic. */
  newId?: (prefix: string) => Id;
}

export function createRecordDirectory(opts: RecordDirectoryOptions): RecordDirectory {
  const defaults = opts.defaults ?? DEFAULT_RECORD_DEFAULTS;
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? defaultNewId;
  /** De-duplicate concurrent first uses of the same session key. */
  const inflight = new Map<Id, Promise<Session>>();

  const ensureProject = async (projectId: Id): Promise<void> => {
    if (await opts.store.getProject(projectId)) return;
    await opts.store.createProject({ id: projectId, name: projectId, createdAt: now() });
  };

  const mintWorktreeId = async (projectId: Id, name: string): Promise<Id> => {
    const base = slug(name) || "worktree";
    for (let i = 1; i < 1000; i += 1) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (candidate === DEFAULT_WORKTREE_ID) continue;
      if (!(await opts.store.getWorktree(projectId, candidate))) return candidate;
    }
    throw new Error("could not mint a unique worktree id");
  };

  return {
    async createProject(name: string): Promise<Project> {
      const project: Project = { id: newId(slug(name) || "project"), name, createdAt: now() };
      return opts.store.createProject(project);
    },
    listProjects: (o) => opts.store.listProjects(o),
    async renameProject(id: Id, name: string): Promise<Project> {
      return opts.store.updateProject(id, { name });
    },
    async archiveProject(id: Id): Promise<Project> {
      return opts.store.archiveProject(id, now());
    },
    async unarchiveProject(id: Id): Promise<Project> {
      return opts.store.unarchiveProject(id);
    },
    async deleteProject(id: Id): Promise<void> {
      await opts.store.deleteProject(id);
    },
    async ensureWorktree(projectId: Id): Promise<Worktree> {
      const existing = await opts.store.getWorktree(projectId, DEFAULT_WORKTREE_ID);
      if (existing) return existing;
      return opts.store.addWorktree({
        id: DEFAULT_WORKTREE_ID,
        projectId,
        name: DEFAULT_WORKTREE_ID,
        branch: MAIN_BRANCH,
        createdAt: now(),
      });
    },
    findWorktree: (projectId, id) => opts.store.getWorktree(projectId, id),
    async requireWorktree(projectId: Id, id: Id): Promise<Worktree> {
      const worktree = await opts.store.getWorktree(projectId, id);
      if (!worktree) throw new WorktreeNotFoundError(projectId, id);
      return worktree;
    },
    mintWorktreeId,
    async addWorktree(
      projectId: Id,
      input: { id: Id; name: string; branch: string },
    ): Promise<Worktree> {
      return opts.store.addWorktree({
        id: input.id,
        projectId,
        name: input.name,
        branch: input.branch,
        createdAt: now(),
      });
    },
    listWorktrees: (projectId, o) => opts.store.listWorktrees(projectId, o),
    async renameWorktree(projectId: Id, id: Id, name: string): Promise<Worktree> {
      return opts.store.updateWorktree(projectId, id, { name });
    },
    async archiveWorktree(projectId: Id, id: Id): Promise<Worktree> {
      return opts.store.archiveWorktree(projectId, id, now());
    },
    async unarchiveWorktree(projectId: Id, id: Id): Promise<Worktree> {
      return opts.store.unarchiveWorktree(projectId, id);
    },
    async deleteWorktree(projectId: Id, id: Id): Promise<void> {
      await opts.store.deleteWorktree(projectId, id);
    },
    async createSession(
      projectId: Id,
      o: { agentId?: Id; title?: string; worktreeId?: Id } = {},
    ): Promise<Session> {
      const project = await opts.store.getProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      const timestamp = now();
      return opts.store.addSession({
        id: newId("sess"),
        projectId,
        agentId: o.agentId ?? defaults.agentId,
        ...(o.worktreeId ? { worktreeId: o.worktreeId } : {}),
        ...(o.title ? { title: o.title } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    listSessions: (projectId, o) => opts.store.listSessions(projectId, o),
    async renameSession(id: Id, title: string): Promise<Session> {
      return opts.store.updateSession(id, { title, updatedAt: now() });
    },
    async archiveSession(id: Id): Promise<Session> {
      return opts.store.archiveSession(id, now());
    },
    async unarchiveSession(id: Id): Promise<Session> {
      return opts.store.unarchiveSession(id);
    },
    async deleteSession(id: Id): Promise<void> {
      await opts.store.deleteSession(id);
    },
    resolveSession: (sessionKey) => opts.store.getSession(sessionKey),
    async resolveOrCreateSession(
      projectId: Id,
      sessionKey: Id,
      worktreeId?: Id,
    ): Promise<Session> {
      const existing = await opts.store.getSession(sessionKey);
      if (existing) return existing;

      let pending = inflight.get(sessionKey);
      if (!pending) {
        pending = (async () => {
          await ensureProject(projectId);
          const timestamp = now();
          return opts.store.addSession({
            id: sessionKey,
            projectId,
            agentId: defaults.agentId,
            worktreeId: worktreeId ?? DEFAULT_WORKTREE_ID,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        })().finally(() => inflight.delete(sessionKey));
        inflight.set(sessionKey, pending);
      }
      return pending;
    },
    listRuns: (projectId) => opts.store.listRuns(projectId),
  };
}

/** A filesystem-safe slug, so a Project id can name its workspace directory. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function defaultNewId(prefix: string): Id {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
