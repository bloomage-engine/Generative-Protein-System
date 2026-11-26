/**
 * The v1 record vocabulary: `Project → Session → Run` (docs/adr/0007).
 *
 * `Study`/`Task`/`Artifact`/`Evidence`/`Conclusion`/`AgentBlueprint` are named and
 * agreed but DEFERRED — no entity here, no API, no rendering — until their real
 * producer or reader is designed (CONTEXT.md, "Deferred vocabulary").
 */

/** Domain identifiers. */
export type Id = string;

/**
 * The top-level container owned by a Researcher or team. A Project owns one
 * Project Workspace and any number of Sessions, and everything its Sessions
 * produce is shared at the Project level (docs/adr/0006).
 *
 * `id` is minted by the server as a filesystem-safe slug and is immutable:
 * workspace directories are named after it, so the workspace outlives a rename.
 */
export interface Project {
  id: Id;
  name: string;
  createdAt: string;
  /** Set when the Project is archived — hidden from the default listing, never deleted. */
  archivedAt?: string;
}

/**
 * A git worktree of a Project's repository: an isolated checkout on its own
 * branch. The Project root IS the `main` worktree; linked worktrees are nested
 * under `.worktrees/` (docs/adr/0025). `id` is a stable slug unique within the
 * Project and `main` is reserved; `name` is the only mutable field. The on-disk
 * path is DERIVED from the id, never stored.
 */
export interface Worktree {
  id: Id;
  projectId: Id;
  /** Display name — the only mutable field. */
  name: string;
  /** The git branch this worktree checks out (stored: it cannot be derived from `id`). */
  branch: string;
  createdAt: string;
  /** Set when the Worktree is archived — hidden from the default listing, never deleted. */
  archivedAt?: string;
}

/** A conversation between a Researcher and an Agent under a Project. */
export interface Session {
  id: Id;
  projectId: Id;
  /**
   * The Worktree this Session runs in. Absent means the `main` worktree — a
   * legacy row written before worktrees existed (normalize with
   * `sessionWorktreeId`).
   */
  worktreeId?: Id;
  /** The Agent identity active in this session (a flat id; `AgentBlueprint` is deferred). */
  agentId: Id;
  /** The display name a Researcher gave the Session (its only mutable field). */
  title?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the Session is archived — hidden from the default listing, never deleted. */
  archivedAt?: string;
}

export type RunStatus = "running" | "completed" | "aborted" | "error";

/**
 * The atomic unit of traceability: one Agent execution in a Session, carrying
 * its inputs, parameters, tool calls, outputs, duration and cost. The Runs of a
 * Project's Sessions are its shared record of results.
 */
export interface Run {
  id: Id;
  sessionId: Id;
  /**
   * Denormalized from the Session so a project rollup (`listRuns(projectId)`) is
   * a direct query and stays correct if the Session is archived.
   */
  projectId: Id;
  status: RunStatus;
  /** The Agent identity that executed this Run. */
  agentId: Id;
  /** Parameters/config applied for this Run (e.g. token usage). */
  parameters: Record<string, unknown>;
  /** Input message that started this Run (the user turn). */
  input: string;
  /** Output/summary text produced by the Run. */
  output?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * A durable, stably-identified session transcript (the runtime's canonical
 * conversation view). The record stores it as an opaque JSON payload — it
 * owns the storage, not the interpretation (the runtime defines the shape).
 */
export interface PersistedTranscript {
  v: 1;
  status: string;
  /** The runtime's full `Message[]` (JSON-safe). The record does not read it. */
  messages: unknown;
}

/**
 * Where a Compute Job stands in its lifecycle (docs/adr/0024):
 * `submitted`/`pending`/`running` are non-terminal, `completed`/`failed`/
 * `cancelled` are terminal, `unknown` means Generative Protein System could not confirm
 * the remote truth and keeps the last known state. The remote scheduler stays
 * the authority; this row is a reconciliation.
 */
export type ComputeJobState =
  | "submitted"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

/** The resource request a Compute Job was submitted with (a snapshot). */
export interface ComputeJobResources {
  partition?: string;
  nodes?: number;
  ntasks?: number;
  cpusPerTask?: number;
  mem?: string;
  time?: string;
}

/**
 * A durable, stably-identified unit of remote work submitted to an HPC
 * Endpoint (docs/adr/0024): the ledger row the Jobs panel reads and the
 * service's poller reconciles. It belongs to a Project; the Session that
 * submitted it is metadata (`sessionKey`).
 */
export interface ComputeJob {
  id: string;
  projectId: string;
  endpointId: string;
  /** Scheduler Kind snapshot — the row stays self-describing after the endpoint is deleted. */
  kind: "slurm" | "linux";
  /** The remote truth: an slurm job id or a linux pid. Set once, at submit. */
  remoteJobId?: string;
  name: string;
  /** slurm: the full sbatch script snapshot. */
  script?: string;
  /** linux: the command-line snapshot. */
  command?: string;
  resources?: ComputeJobResources;
  /** The remote job dir the pid/rc/log files live under (linux) or the -o/-e parent (slurm). */
  remoteDir?: string;
  state: ComputeJobState;
  exitCode?: number;
  nodeList?: string;
  /** The submitting Session when it is a known record id (best-effort). */
  sessionKey?: string;
  /** Last submit/reconcile failure detail (e.g. the SSH error behind an `unknown`). */
  error?: string;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/**
 * A durable, stably-identified subagent (a lineage-bearing, self-contained
 * session): its stable id, durable parent-session link, run metadata, and its
 * own captured transcript.
 */
export interface Subagent {
  id: Id;
  parentSessionId: Id;
  origin: "subagent";
  label?: string;
  provider?: string;
  status: "running" | "completed" | "aborted" | "error";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  transcript?: PersistedTranscript;
}
