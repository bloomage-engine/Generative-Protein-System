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
 * A whole (not incremental) snapshot of a session's canonical transcript,
 * pushed to standing watchers (the transport-service's `subscribe` sink). This
 * is the client's owned wire shape — `messages` keyed by id — so a frontend
 * can adopt it verbatim via `importExternalState` without folding deltas.
 */
export interface WatchSnapshot {
  status: SessionState["status"];
  messages: Record<string, Message>;
}

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
  | {
      /**
       * Replace the text of the part at `partIndex` (only text or reasoning
       * parts carry a `text` field). Collapses high-frequency full-cumulative-
       * text events (e.g. gateway `thinking` streams, ~13 Hz) into one part
       * updated in place instead of a whole-parts-array rewrite per event.
       */
      type: "set-part-text";
      messageId: Id;
      partIndex: number;
      text: string;
    }
  | { type: "approval-required"; approvalId: Id; kind: string; summary: string };

/**
 * A command from the frontend, adapted from assistant-ui's transport commands
 * and kept decoupled so this package stays React-free.
 */
export type TransportCommand =
  | { type: "add-message"; message: { id: Id; role: "user" | "assistant"; content: string } }
  | { type: "add-tool-result"; toolCallId: Id; result: string };

/**
 * A runtime command surfaced to the frontend slash menu. Descriptors are
 * produced by a runtime adapter from its own catalog (for openclaw, the
 * gateway's `commands.list`) and are runtime-agnostic in shape, so the
 * frontend can render a menu without knowing the runtime (see docs/adr/0003).
 */
export interface CommandDescriptor {
  /** Stable command id (e.g. "model"). */
  id: string;
  /** Short human-readable name shown in the menu. */
  label: string;
  /** One-line description of what the command does. */
  description: string;
  /** Optional icon key; the client resolves it against its own icon set. */
  icon?: string;
  /** Optional grouping key for categorizing menu entries. */
  category?: string;
  /**
   * The exact message text that invokes this command (e.g. "/status").
   * Commands are plain "/"-prefixed messages end-to-end; the adapter sends
   * this text to its runtime and never persists a Run for it.
   */
  invocationText: string;
}

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
  /**
   * Command catalog for the frontend slash menu, adapted from the runtime's
   * own command list (for openclaw, the gateway's `commands.list`) into
   * runtime-agnostic `CommandDescriptor`s. Executing a command is NOT a
   * `Run`: adapters treat "/"-prefixed user text as a runtime command and
   * never persist a Run for it (see docs/adr/0003).
   * Optional — adapters without a command surface omit it.
   */
  listCommands?(): Promise<CommandDescriptor[]>;
  /**
   * The canonical session key a client `threadId` targets. Runtimes whose
   * session namespace differs from raw client thread ids implement this and
   * keep that knowledge out of the runtime-agnostic transport-service:
   * assistant-ui mints a per-page local `__LOCALID_*` id that must NOT become
   * the canonical session, and gateway-style runtimes namespace their sessions
   * (openclaw: `agent:…`). `null` means the client claimed no session (the
   * mount probe). Default when omitted: the threadId itself when non-empty,
   * else `"default"`.
   * Optional — plain runtimes that accept any client-chosen id verbatim
   * omit it.
   */
  resolveSessionKey?(threadId: string | null): string;
  /**
   * Standing watch: keep pushing the session's canonical `WatchSnapshot`
   * whenever its transcript settles (e.g. a reply that arrived from another
   * channel — the openclaw TUI/UI — with no client-driven run in flight from
   * us). Called once immediately on attach (baseline) and again on each
   * coalesced settle. Return an unsubscribe to detach the sink.
   * Optional — adapters that can't observe remote activity omit it.
   */
  subscribe?(
    sessionId: string,
    sink: (snapshot: WatchSnapshot) => void,
  ): () => void;
}

export interface RuntimeInitOptions {
  gateway: RuntimeConfig;
  recordStore: RecordStoreLike;
  /**
   * Optional runtime-agnostic configuration bag (a service-provided env
   * slice). Network runtimes (openclaw) read `gateway`; process runtimes
   * (dsh: a spawned local harness) read their own keys here (e.g. `DSH_*`)
   * because their launch surface is not a url/token pair. Keep adapter-
   * specific keys out of the shared seam's own shape.
   */
  config?: Record<string, string | undefined>;
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
