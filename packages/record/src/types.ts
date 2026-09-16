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

/** A conversation between a Researcher and an Agent under a Project. */
export interface Session {
  id: Id;
  projectId: Id;
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
