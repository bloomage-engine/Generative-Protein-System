/**
 * Domain identifiers.
 */
export type Id = string;

/** A Researcher-defined objective pursued under a Project. */
export interface Study {
  id: Id;
  projectId: Id;
  /** One-sentence research objective. */
  objective: string;
  createdAt: string;
}

/** The top-level container owned by a Researcher or team. */
export interface Project {
  id: Id;
  name: string;
  createdAt: string;
}

/** A concrete piece of work delegated to an Agent. */
export interface Task {
  id: Id;
  studyId: Id;
  agentBlueprintId: Id;
  /** Free-form prompt / goal given to the Agent. */
  prompt: string;
  createdAt: string;
}

/**
 * The atomic unit of traceability: one Agent execution against a Task,
 * carrying inputs, parameters, tool calls, outputs, duration and cost.
 */
export interface Run {
  id: Id;
  taskId: Id;
  sessionId: Id;
  status: RunStatus;
  /** The Agent identity that executed this Run. */
  agentId: Id;
  /** Parameters/config applied for this Run. */
  parameters: Record<string, unknown>;
  /** Input message that started this Run (the user turn). */
  input: string;
  /** Output/summary text produced by the Run. */
  output?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type RunStatus =
  | "running"
  | "completed"
  | "aborted"
  | "error";

/** An output produced by a Run — dataset, figure, report, code, model. */
export interface Artifact {
  id: Id;
  runId: Id;
  name: string;
  kind: ArtifactKind;
  /** Where the artifact lives (a URL, URI, or reference). */
  location?: string;
  /** JSON summary (shape, hash, size, etc.). */
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type ArtifactKind =
  | "dataset"
  | "figure"
  | "report"
  | "code"
  | "model"
  | "other";

/** The chain linking a Run to its inputs, steps, Artifacts and conclusions. */
export interface Evidence {
  id: Id;
  runId: Id;
  /** Structured provenance between entities, e.g. a Run → an input Artifact. */
  relationships: {
    from: Id;
    to: Id;
    type: string;
  }[];
}

/** A synthesized finding presented to the Researcher, citing Evidence. */
export interface Conclusion {
  id: Id;
  studyId: Id;
  /** References to the Evidence / Runs that support this conclusion. */
  evidenceIds: Id[];
  text: string;
  createdAt: string;
}

/** A reusable definition of an Agent: instructions, tools, model, parameters. */
export interface AgentBlueprint {
  id: Id;
  name: string;
  model?: string;
  instructions?: string;
  /** Tool identifiers available to the Agent. */
  tools: string[];
  parameters: Record<string, unknown>;
}

/**
 * A conversation between a Researcher and an Agent under a Study.
 * Rendered as an assistant-ui thread. Each Researcher turn drives one Run.
 */
export interface Session {
  id: Id;
  studyId: Id;
  /** The AgentBlueprint active in this session. */
  agentBlueprintId: Id;
  title?: string;
  createdAt: string;
  updatedAt: string;
}
