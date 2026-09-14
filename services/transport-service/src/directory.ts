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
import type { Id, Project, RecordStore, Run, Session } from "@science-studio/record";

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

export interface RecordDirectory {
  /** Create a Project; its id is a slug of `name` (unique-suffixed). */
  createProject(name: string): Promise<Project>;
  listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
  archiveProject(id: Id): Promise<Project>;
  createSession(projectId: Id, opts?: { agentId?: Id; title?: string }): Promise<Session>;
  listSessions(projectId: Id): Promise<Session[]>;
  /** The Session a canonical runtime session key belongs to, or null. */
  resolveSession(sessionKey: string): Promise<Session | null>;
  /**
   * Find — or lazily mint — the Session a canonical session key names under a
   * Project, creating the Project row too if it is missing. Mount probes and
   * clients that name no Project must keep converging (see the Phase 2.6 note in
   * docs/design/implementation-plan.md), so the transport route resolves through
   * here rather than refusing an unknown key.
   */
  resolveOrCreateSession(projectId: Id, sessionKey: Id): Promise<Session>;
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

  return {
    async createProject(name: string): Promise<Project> {
      const project: Project = { id: newId(slug(name) || "project"), name, createdAt: now() };
      return opts.store.createProject(project);
    },
    listProjects: (o) => opts.store.listProjects(o),
    async archiveProject(id: Id): Promise<Project> {
      return opts.store.archiveProject(id, now());
    },
    async createSession(projectId: Id, o: { agentId?: Id; title?: string } = {}): Promise<Session> {
      const project = await opts.store.getProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      const timestamp = now();
      return opts.store.addSession({
        id: newId("sess"),
        projectId,
        agentId: o.agentId ?? defaults.agentId,
        ...(o.title ? { title: o.title } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    listSessions: (projectId) => opts.store.listSessions(projectId),
    resolveSession: (sessionKey) => opts.store.getSession(sessionKey),
    async resolveOrCreateSession(projectId: Id, sessionKey: Id): Promise<Session> {
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
