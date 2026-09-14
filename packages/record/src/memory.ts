import type { Id, Project, Run, Session } from "./types.js";
import type { RecordStore } from "./index.js";

/**
 * Dev/test-grade in-memory implementation of the authoritative record store.
 * Entities are stored by id and returned as copies; nothing is ever removed
 * (archiving is a flag), so listing order is insertion order.
 */
export function createInMemoryRecordStore(): RecordStore {
  const projects = new Map<Id, Project>();
  const sessions = new Map<Id, Session>();
  const runs = new Map<Id, Run>();

  const clone = <T>(v: T): T => structuredClone(v);
  const ordered = <T>(map: Map<Id, T>, matches: (v: T) => boolean): T[] =>
    [...map.values()].filter(matches).map(clone);

  return {
    async createProject(project: Project): Promise<Project> {
      projects.set(project.id, clone(project));
      return clone(project);
    },
    async getProject(id: Id): Promise<Project | null> {
      const p = projects.get(id);
      return p ? clone(p) : null;
    },
    async listProjects(opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
      return ordered(projects, (p) => opts.includeArchived === true || p.archivedAt === undefined);
    },
    async archiveProject(id: Id, archivedAt: string): Promise<Project> {
      const prev = projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, archivedAt };
      projects.set(id, clone(next));
      return clone(next);
    },
    async addSession(session: Session): Promise<Session> {
      sessions.set(session.id, clone(session));
      return clone(session);
    },
    async getSession(id: Id): Promise<Session | null> {
      const s = sessions.get(id);
      return s ? clone(s) : null;
    },
    async listSessions(projectId: Id): Promise<Session[]> {
      return ordered(sessions, (s) => s.projectId === projectId);
    },
    async addRun(run: Run): Promise<Run> {
      runs.set(run.id, clone(run));
      return clone(run);
    },
    async listRuns(projectId: Id): Promise<Run[]> {
      return ordered(runs, (r) => r.projectId === projectId);
    },
  };
}
