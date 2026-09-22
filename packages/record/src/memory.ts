import type {
  ComputeJob,
  Id,
  Project,
  Run,
  Session,
  PersistedTranscript,
  Subagent,
} from "./types.js";
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
  const transcripts = new Map<Id, PersistedTranscript>();
  const subagents = new Map<Id, Subagent>();
  const computeJobs = new Map<Id, ComputeJob>();

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
    async updateProject(id: Id, patch: { name: string }): Promise<Project> {
      const prev = projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, name: patch.name };
      projects.set(id, clone(next));
      return clone(next);
    },
    async archiveProject(id: Id, archivedAt: string): Promise<Project> {
      const prev = projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const next = { ...prev, archivedAt };
      projects.set(id, clone(next));
      return clone(next);
    },
    async unarchiveProject(id: Id): Promise<Project> {
      const prev = projects.get(id);
      if (!prev) throw new Error(`project not found: ${id}`);
      const { archivedAt: _dropped, ...rest } = prev;
      projects.set(id, clone(rest));
      return clone(rest);
    },
    async deleteProject(id: Id): Promise<void> {
      const projectSessions = new Set<Id>(
        [...sessions.values()].filter((session) => session.projectId === id).map((session) => session.id),
      );
      projects.delete(id);
      for (const session of [...sessions.values()]) {
        if (session.projectId === id) {
          sessions.delete(session.id);
          transcripts.delete(session.id);
        }
      }
      for (const run of [...runs.values()]) {
        if (run.projectId === id) runs.delete(run.id);
      }
      for (const sub of [...subagents.values()]) {
        if (projectSessions.has(sub.parentSessionId)) subagents.delete(sub.id);
      }
      // Compute Jobs belong to the Project (docs/adr/0024); deleting the
      // Project cascades the ROWS only — a delete never touches the cluster.
      for (const job of [...computeJobs.values()]) {
        if (job.projectId === id) computeJobs.delete(job.id);
      }
    },
    async addSession(session: Session): Promise<Session> {
      sessions.set(session.id, clone(session));
      return clone(session);
    },
    async getSession(id: Id): Promise<Session | null> {
      const s = sessions.get(id);
      return s ? clone(s) : null;
    },
    async listSessions(
      projectId: Id,
      opts: { includeArchived?: boolean } = {},
    ): Promise<Session[]> {
      return ordered(
        sessions,
        (s) => s.projectId === projectId && (opts.includeArchived === true || s.archivedAt === undefined),
      );
    },
    async updateSession(id: Id, patch: { title: string; updatedAt: string }): Promise<Session> {
      const prev = sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const next = { ...prev, title: patch.title, updatedAt: patch.updatedAt };
      sessions.set(id, clone(next));
      return clone(next);
    },
    async archiveSession(id: Id, archivedAt: string): Promise<Session> {
      const prev = sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const next = { ...prev, archivedAt };
      sessions.set(id, clone(next));
      return clone(next);
    },
    async unarchiveSession(id: Id): Promise<Session> {
      const prev = sessions.get(id);
      if (!prev) throw new Error(`session not found: ${id}`);
      const { archivedAt: _dropped, ...rest } = prev;
      sessions.set(id, clone(rest));
      return clone(rest);
    },
    async deleteSession(id: Id): Promise<void> {
      sessions.delete(id);
      for (const run of [...runs.values()]) {
        if (run.sessionId === id) runs.delete(run.id);
      }
      transcripts.delete(id);
      for (const sub of [...subagents.values()]) {
        if (sub.parentSessionId === id) subagents.delete(sub.id);
      }
    },
    async addRun(run: Run): Promise<Run> {
      runs.set(run.id, clone(run));
      return clone(run);
    },
    async listRuns(projectId: Id): Promise<Run[]> {
      return ordered(runs, (r) => r.projectId === projectId);
    },
    // Durable session transcript + subagents (docs/adr/0019): the record
    // owns storage; the runtime (adapter) owns the transcript shape.
    async saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void> {
      transcripts.set(sessionId, clone(doc));
    },
    async loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null> {
      const d = transcripts.get(sessionId);
      return d ? clone(d) : null;
    },
    async upsertSubagent(subagent: Subagent): Promise<void> {
      subagents.set(subagent.id, clone(subagent));
    },
    async loadSubagent(id: Id): Promise<Subagent | null> {
      const s = subagents.get(id);
      return s ? clone(s) : null;
    },
    async listSubagents(parentSessionId: Id): Promise<Subagent[]> {
      return ordered(subagents, (s) => s.parentSessionId === parentSessionId);
    },
    // Durable Compute Jobs (docs/adr/0024): the service writes these directly
    // — there is no adapter view of them, so the deletion cascade is the only
    // lifecycle coupling to the rest of the store.
    async upsertComputeJob(job: ComputeJob): Promise<void> {
      computeJobs.set(job.id, clone(job));
    },
    async loadComputeJob(id: Id): Promise<ComputeJob | null> {
      const job = computeJobs.get(id);
      return job ? clone(job) : null;
    },
    async listComputeJobs(projectId: Id): Promise<ComputeJob[]> {
      return ordered(computeJobs, (job) => job.projectId === projectId);
    },
  };
}
