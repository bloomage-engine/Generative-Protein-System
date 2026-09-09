import { Transcript, type Message, type SessionState } from "@science-studio/transport";
import type { SessionEvent, TurnEndReason } from "@deepseek-ai/dsh-session";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { contentToParts, extractResultText, findToolCallPart, turnEndStatus } from "./mapping.js";

/** What one committed dsh event did to the canonical transcript. */
export interface ApplyMeta {
  /** The `turn/end` reason, when this event closed a turn. */
  reason?: TurnEndReason;
  /** Token accounting riding an `assistant/message`, when the adapter reported it. */
  usage?: TokenUsage;
}

/**
 * The adapter-owned canonical transcript for one Harness session. Rides the
 * shared transcript shell from @science-studio/transport (the same one the
 * openclaw adapter's transcript subclasses): `StateDelta`s are folded here
 * (ONE fold — `foldState` in @science-studio/transport) AND pushed to the
 * attached flow, so the canonical state, the wire mirror in the transport-
 * service, and the client can never drift apart.
 *
 * Science Studio owns this record (docs/adr/0002): dsh's own session log is
 * the runtime's business. The transcript is seeded from our own persisted
 * mirror on cold start (never from dsh internals), because the SDK wire has no
 * history-replay request and reading dsh's volatile session-log format would
 * couple us to an unstable internal (docs/adr/0004).
 */
export class DshTranscript extends Transcript {
  constructor(sessionKey: string, initial: Pick<SessionState, "studyId" | "agentId">) {
    super(sessionKey, {
      sessionId: sessionKey,
      studyId: initial.studyId,
      agentId: initial.agentId,
      status: "idle",
      messages: [],
    });
  }

  /** Adopt a persisted mirror (cold start) or the client-implied baseline. */
  restore(messages: Message[], status: SessionState["status"]): void {
    this.state.status = status;
    this.state.messages = structuredClone(messages);
  }

  /**
   * Fold one committed dsh session event into canonical deltas.
   *
   * Event → delta mapping (committed-event granularity, no token stream):
   * - `turn/start` opens `running`; `turn/end` maps its reason to `idle`/`error`
   *   and reports the reason for Run persistence;
   * - `assistant/message` materializes ONE whole assistant message (per step,
   *   text + reasoning + tool-call blocks in content order) — dsh pushes no
   *   token fragments, and we never fabricate them;
   * - `tool/result` attaches the tool's text output into the matching
   *   `tool-call` part by `callId` (start and result coalesced into one part,
   *   as in the openclaw adapter);
   * - `user/message` is ignored: the driving user row is pre-added with the
   *   CLIENT's message id (the wire folds it to the same key the composer
   *   rendered), and injected non-prompt user rows have no seam rendering.
   */
  apply(event: SessionEvent): ApplyMeta {
    switch (event.type) {
      case "turn/start":
        if (this.state.status !== "running") {
          this.emit({ type: "session-status", status: "running" });
        }
        return {};
      case "turn/end": {
        const reason = event.data.reason;
        const status = turnEndStatus(reason);
        if (this.state.status !== status) {
          this.emit({ type: "session-status", status });
        }
        return { reason };
      }
      case "assistant/message": {
        const data = event.data;
        if (data.message.role !== "assistant") return {};
        const existing = this.state.messages.find((m) => m.id === data.message.id);
        if (existing) return data.usage ? { usage: data.usage } : {};
        this.emit({
          type: "add-message",
          message: {
            id: data.message.id,
            role: "assistant",
            parts: contentToParts(data.message.content),
          },
        });
        return data.usage ? { usage: data.usage } : {};
      }
      case "tool/result": {
        const data = event.data;
        const resultBlock = data.message.content[0];
        if (resultBlock?.type !== "tool-result") return {};
        const callId = resultBlock.toolCallId;
        const message = this.state.messages.find((m) =>
          m.parts.some((p) => p.type === "tool-call" && p.id === callId),
        );
        if (!message) return {};
        const found = findToolCallPart(message, callId);
        if (!found) return {};
        const resultText = extractResultText(data.message.content);
        const isError = Boolean(data.error) || resultBlock.isError === true;
        const parts = message.parts.map((p) =>
          p.type === "tool-call" && p.id === callId
            ? { ...p, result: resultText, isError: isError || undefined }
            : p,
        );
        this.emit({ type: "update-message", messageId: message.id, patch: { parts } });
        return {};
      }
      default:
        // system/message, user/message, step/*, assistant/attempt,
        // request/* — no seam rendering; nothing to fold.
        return {};
    }
  }
}
