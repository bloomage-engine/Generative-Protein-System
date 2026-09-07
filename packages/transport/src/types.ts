import type { Id, Run } from "@science-studio/record";

/**
 * The normalized session state that a runtime adapter owns and that the
 * transport-service streams to the frontend. This is Science Studio's owned
 * state — NOT a runtime transcript — so the frontend converter stays
 * runtime-agnostic (see docs/adr/0002).
 */
export interface SessionState {
  sessionId: Id;
  studyId: Id;
  agentId: Id;
  status: "idle" | "running" | "error";
  messages: Message[];
}

/** A message within the normalized session state. */
export interface Message {
  id: Id;
  role: "user" | "assistant";
  parts: MessagePart[];
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: Id; name: string; args: string; result?: string; isError?: boolean }
  | { type: "artifact"; artifactId: Id; name: string; kind: string };

/**
 * Incremental updates to a SessionState. A runtime adapter yields these; the
 * transport-service folds them into a state snapshot and streams it out.
 */
export type StateDelta =
  | { type: "session-status"; status: SessionState["status"] }
  | {
      type: "reconcile";
      status: SessionState["status"];
      /** The full authoritative transcript, in canonical order. */
      messages: Message[];
    }
  | { type: "add-message"; message: Message }
  | { type: "update-message"; messageId: Id; patch: Partial<Message> }
  | { type: "add-part"; messageId: Id; part: MessagePart }
  | { type: "append-text"; messageId: Id; text: string }
  | {
      /**
       * A streaming text fragment: append to (or, with `replace`, replace) the
       * message's trailing text part — mirrors the gateway's `chat` `delta`
       * events (`deltaText`), which carry one token chunk per event.
       */
      type: "stream-text";
      messageId: Id;
      text: string;
      replace?: boolean;
    }
  | { type: "approval-required"; approvalId: Id; kind: string; summary: string };

/**
 * A command from the frontend, adapted from assistant-ui's transport commands
 * and kept decoupled so this package stays React-free.
 */
export type TransportCommand =
  | { type: "add-message"; message: { id: Id; role: "user" | "assistant"; content: string } }
  | { type: "add-tool-result"; toolCallId: Id; result: string };

/** Reserved seam for Artifact capture; wired up in a later iteration. */
export interface ArtifactInput {
  runId: Id;
  name: string;
  kind: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The runtime-agnostic boundary. A concrete runtime (openclaw, codex, …)
 * implements this interface; the transport-service drives it, and the frontend
 * only ever speaks the assistant-ui transport protocol.
 */
export interface RuntimeAdapter {
  /** Human-readable runtime identifier, e.g. "openclaw". */
  runtime: string;
  /** Lifecycle: called once when the adapter is registered. */
  init(opts: RuntimeInitOptions): Promise<void>;
  /**
   * Drive the runtime for a batch of commands, yielding state deltas that
   * advance the supplied session state.
   */
  run(session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta>;
  /** Abort the in-flight run, if any. */
  abort(reason?: string): void;
  /** Resolve a pending approval. */
  approve(approvalId: string, decision: "approve" | "reject"): void;
  /** Reserved: Artifact capture, wired later. */
  onArtifact?(artifact: ArtifactInput): void;
}

export interface RuntimeInitOptions {
  gateway: RuntimeConfig;
  recordStore: RecordStoreLike;
}

/** Runtime-agnostic connection config (bound per adapter). */
export interface RuntimeConfig {
  url: string;
  token: string;
}

/** Narrow view of the record store an adapter uses to persist Runs/Artifacts. */
export interface RecordStoreLike {
  addRun(run: Run): Promise<void>;
  addArtifact(artifact: ArtifactInput): Promise<void>;
}
