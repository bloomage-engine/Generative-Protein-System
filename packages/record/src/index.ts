import type { Id, Project, Run, Session } from "./types.js";

// The domain vocabulary, listed explicitly so this file is the package surface.
export type { Id, Project, Run, RunStatus, Session } from "./types.js";
export { createInMemoryRecordStore } from "./memory.js";
export { createJsonlRecordStore } from "./jsonl.js";

/**
 * The authoritative storage boundary for the v1 research record
 * (`Project → Session → Run`, docs/adr/0007).
 *
 * Science Studio owns the record; runtimes are adapters behind a transport seam
 * and never own it (see docs/adr/0002). This is the RECORD seam: an out-of-tree
 * implementer (the private enterprise module) supplies its own implementation.
 *
 * Listing methods return insertion order (the order rows were recorded), which
 * is stable and cheap for both implementations; callers that want "newest
 * first" reverse. There is no delete in v1 — a Project is archived, not removed.
 */
export interface RecordStore {
  createProject(project: Project): Promise<Project>;
  getProject(id: Id): Promise<Project | null>;
  /** Insertion order. Archived projects are excluded unless asked for. */
  listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
  /** Mark a Project archived; returns the updated row. */
  archiveProject(id: Id, archivedAt: string): Promise<Project>;

  /**
   * Record a conversation. A Session's id IS its canonical runtime session key,
   * so a runtime session and a Science Studio Session are 1:1.
   */
  addSession(session: Session): Promise<Session>;
  getSession(id: Id): Promise<Session | null>;
  /** A Project's Sessions, insertion order. */
  listSessions(projectId: Id): Promise<Session[]>;

  addRun(run: Run): Promise<Run>;
  /** A Project's Runs (the turns of all its Sessions), insertion order. */
  listRuns(projectId: Id): Promise<Run[]>;
}
