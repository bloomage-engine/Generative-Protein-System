import type {
  ComputeJob,
  Id,
  Project,
  Run,
  Session,
  PersistedTranscript,
  Subagent,
} from "./types.js";

// The domain vocabulary, listed explicitly so this file is the package surface.
export type {
  ComputeJob,
  ComputeJobResources,
  ComputeJobState,
  Id,
  Project,
  Run,
  RunStatus,
  Session,
  PersistedTranscript,
  Subagent,
} from "./types.js";

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
 * first" reverse.
 *
 * Lifecycle (docs/adr/0014): a rename updates the mutable label (`Project.name`,
 * `Session.title`) while the id stays immutable — a Project's id names its
 * workspace directory. Archiving is a reversible flag; deleting removes the row
 * and cascades (a Project removes its Sessions and their Runs, a Session removes
 * its Runs). The default Project's immutability is enforced at the service, not
 * here: the store just stores.
 */
export interface RecordStore {
  createProject(project: Project): Promise<Project>;
  getProject(id: Id): Promise<Project | null>;
  /** Insertion order. Archived projects are excluded unless asked for. */
  listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
  /** Rename a Project (its id is immutable). Returns the updated row. */
  updateProject(id: Id, patch: { name: string }): Promise<Project>;
  /** Mark a Project archived; returns the updated row. */
  archiveProject(id: Id, archivedAt: string): Promise<Project>;
  /** Clear a Project's archived flag; returns the updated row. */
  unarchiveProject(id: Id): Promise<Project>;
  /** Remove a Project and every Session/Run (and Compute Job — docs/adr/0024) under it. */
  deleteProject(id: Id): Promise<void>;

  /**
   * Record a conversation. A Session's id IS its canonical runtime session key,
   * so a runtime session and a Science Studio Session are 1:1.
   */
  addSession(session: Session): Promise<Session>;
  getSession(id: Id): Promise<Session | null>;
  /** A Project's Sessions, insertion order. Archived sessions excluded unless asked for. */
  listSessions(projectId: Id, opts?: { includeArchived?: boolean }): Promise<Session[]>;
  /** Rename a Session (its `title`). Returns the updated row. */
  updateSession(id: Id, patch: { title: string; updatedAt: string }): Promise<Session>;
  /** Mark a Session archived; returns the updated row. */
  archiveSession(id: Id, archivedAt: string): Promise<Session>;
  /** Clear a Session's archived flag; returns the updated row. */
  unarchiveSession(id: Id): Promise<Session>;
  /** Remove a Session and every Run under it. */
  deleteSession(id: Id): Promise<void>;

  addRun(run: Run): Promise<Run>;
  /** A Project's Runs (the turns of all its Sessions), insertion order. */
  listRuns(projectId: Id): Promise<Run[]>;

  // Durable session transcript: the runtime's canonical conversation view
  // (docs/adr/0019). Stored opaquely by the record — the runtime owns the shape.
  saveSessionTranscript(sessionId: Id, doc: PersistedTranscript): Promise<void>;
  loadSessionTranscript(sessionId: Id): Promise<PersistedTranscript | null>;
  // Durable subagents: stably-identified, lineage-bearing, self-contained
  // sessions (docs/adr/0019).
  upsertSubagent(subagent: Subagent): Promise<void>;
  loadSubagent(id: Id): Promise<Subagent | null>;
  /** A parent-session's subagents. NO ORDER is guaranteed (insertion/readdir);
   *  consumers that need a deterministic order sort on their own (the panel sorts by startedAt). */
  listSubagents(parentSessionId: Id): Promise<Subagent[]>;
  // Durable Compute Jobs (docs/adr/0024): the ledger the Jobs panel reads and
  // the service's poller reconciles. The SERVICE writes it — no adapter view
  // of these methods exists on purpose.
  upsertComputeJob(job: ComputeJob): Promise<void>;
  loadComputeJob(id: Id): Promise<ComputeJob | null>;
  /** A Project's Compute Jobs. NO ORDER is guaranteed (readdir); consumers sort. */
  listComputeJobs(projectId: Id): Promise<ComputeJob[]>;
}
