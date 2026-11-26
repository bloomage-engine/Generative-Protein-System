/**
 * Pure, adapter-side support for the dsh child's LIVE assistant stream.
 *
 * The harness publishes a process-local `agent/assistant-stream` event
 * (start / chunk / end) for every `StreamChunk`; the child-side bridge plugin
 * forwards them over its private socket (`bridge-plugin.ts`). This module owns
 * the frame vocabulary and the state machine that turns one attempt's chunks
 * into the shared `StateDelta` ops — unit-tested without a runtime.
 *
 * The durable `assistant/message` event stays authoritative: a
 * {@link LiveAssistantMessage} only decides WHEN parts appear, and the
 * committed event overwrites the row's parts with `contentToParts(...)` at
 * settlement (`behavior.ts`, docs/adr/0022).
 */
import type { MessagePart, StateDelta } from "@gps/transport";

/** One forwarded frame's dsh-llm `StreamChunk` fields, read structurally. */
export interface LiveStreamChunk {
  type?: string;
  index?: number;
  blockType?: string;
  text?: string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  /** `block-end` carries the assembled block. */
  block?: { type?: string; text?: string; id?: string; name?: string; arguments?: string };
}

/**
 * One process-local `agent/assistant-stream` frame, as the bridge forwards it.
 * `sessionId` rides the envelope (the plugin adds it from `agent.session.id`),
 * not the dsh frame itself.
 */
export interface AssistantStreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: string;
  revision?: number;
  turn?: number;
  step?: number;
  index?: number;
  time?: number;
  chunk?: LiveStreamChunk;
  /** `end` carries the durable settlement (or abandonment) of the attempt. */
  outcome?: { kind?: string; eventType?: string; seq?: number };
}

/** One forwarded envelope: the harness session id plus its frame. */
export interface DshAssistantStreamMessage {
  sessionId: string;
  frame: AssistantStreamFrame;
}

type BlockKind = "none" | "text" | "reasoning" | "tool-call";

/**
 * One live assistant row under construction. It emits only shared
 * `StateDelta` ops (folded by `foldState`, streamed by the wire) and keeps a
 * local block model so reasoning and text stream into the RIGHT part: the
 * `stream-*` ops grow the trailing part of their own kind, so a block change
 * naturally starts a new part.
 *
 * The caller owns the row's lifecycle: `begin()` on the FIRST start frame of a
 * `(session, turn, step)`, `reset()` on a later one (a retried attempt reuses
 * the row), and the durable `assistant/message` finalizes it.
 */
export class LiveAssistantMessage {
  private kind: BlockKind = "none";
  private tool: { id: string; name: string; args: string; partIndex: number } | null = null;
  /**
   * The row's own mirror of the parts assembled so far, kept in sync with the
   * `stream-*` / `add-part` ops so a later whole-parts `update-message` is
   * complete. Every emitted whole-parts patch carries a FRESH array (the
   * runtime's fold and the `RunFlow` queue treat a delta as immutable), but its
   * PART OBJECTS are shared with this mirror — safe because this class never
   * mutates a part in place (it replaces the slot with a new object).
   */
  private parts: MessagePart[] = [];

  constructor(
    readonly messageId: string,
    private readonly emit: (delta: StateDelta) => void,
  ) {}

  /** The row does not exist yet: create it empty. */
  begin(): void {
    this.resetState();
    this.emit({ type: "add-message", message: { id: this.messageId, role: "assistant", parts: [] } });
  }

  /** The row already exists (a retried attempt): clear its parts and rebuild. */
  reset(): void {
    this.resetState();
    this.emit({ type: "update-message", messageId: this.messageId, patch: { parts: [] } });
  }

  private resetState(): void {
    this.kind = "none";
    this.tool = null;
    this.parts = [];
  }

  /**
   * Grow the trailing part of `type` with `text`, else start a new one — the
   * same trailing-part rule `foldState` applies to `stream-text` /
   * `stream-reasoning`, so the local mirror matches what the wire fold builds.
   */
  private appendTrailing(type: "text" | "reasoning", text: string): void {
    const idx = this.parts.length - 1;
    const last = idx >= 0 ? this.parts[idx] : undefined;
    if (last && last.type === type) {
      this.parts[idx] = { type, text: last.text + text };
    } else {
      this.parts.push({ type, text });
    }
  }

  private toolPart(tool: { id: string; name: string; args: string }): Extract<
    MessagePart,
    { type: "tool-call" }
  > {
    return { type: "tool-call", id: tool.id, name: tool.name, args: tool.args };
  }

  /** Map one `StreamChunk`, ignoring block/usage/finish chunks it has no rendering for. */
  accept(chunk: LiveStreamChunk): void {
    switch (chunk.type) {
      case "block-start":
        this.kind =
          chunk.blockType === "reasoning"
            ? "reasoning"
            : chunk.blockType === "text"
              ? "text"
              : chunk.blockType === "tool-call"
                ? "tool-call"
                : "none";
        if (this.kind === "tool-call") this.tool = null;
        return;
      case "text-delta":
        if (this.kind === "text" && typeof chunk.text === "string") {
          this.emit({ type: "stream-text", messageId: this.messageId, text: chunk.text });
          this.appendTrailing("text", chunk.text);
        }
        return;
      case "reasoning-delta":
        if (this.kind === "reasoning" && typeof chunk.text === "string") {
          this.emit({ type: "stream-reasoning", messageId: this.messageId, text: chunk.text });
          this.appendTrailing("reasoning", chunk.text);
        }
        return;
      case "tool-call-delta": {
        if (this.kind !== "tool-call") return;
        if (this.tool === null) {
          this.tool = {
            id: typeof chunk.id === "string" ? chunk.id : "",
            name: typeof chunk.name === "string" ? chunk.name : "",
            args: typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "",
            partIndex: this.parts.length,
          };
          const part = this.toolPart(this.tool);
          this.parts.push(part);
          this.emit({ type: "add-part", messageId: this.messageId, part });
        } else {
          if (typeof chunk.name === "string" && chunk.name !== "") this.tool.name = chunk.name;
          if (typeof chunk.argumentsDelta === "string") this.tool.args += chunk.argumentsDelta;
          const part = this.toolPart(this.tool);
          this.parts[this.tool.partIndex] = part;
          this.emit({
            type: "update-message",
            messageId: this.messageId,
            patch: { parts: [...this.parts] },
          });
        }
        return;
      }
      case "block-end": {
        const block = chunk.block;
        if (this.kind === "tool-call") {
          const id = this.tool?.id || (typeof block?.id === "string" ? block.id : "");
          const name = this.tool?.name || (typeof block?.name === "string" ? block.name : "");
          const args =
            typeof block?.arguments === "string" ? block.arguments : (this.tool?.args ?? "");
          if (this.tool !== null) {
            const current = this.parts[this.tool.partIndex];
            const changed =
              !current ||
              current.type !== "tool-call" ||
              current.id !== id ||
              current.name !== name ||
              current.args !== args;
            if (changed) {
              const part: Extract<MessagePart, { type: "tool-call" }> = {
                type: "tool-call",
                id,
                name,
                args,
              };
              this.parts[this.tool.partIndex] = part;
              this.emit({
                type: "update-message",
                messageId: this.messageId,
                patch: { parts: [...this.parts] },
              });
            }
          } else if (block?.type === "tool-call") {
            const part: Extract<MessagePart, { type: "tool-call" }> = {
              type: "tool-call",
              id,
              name,
              args,
            };
            this.parts.push(part);
            this.emit({ type: "add-part", messageId: this.messageId, part });
          }
        }
        this.tool = null;
        this.kind = "none";
        return;
      }
      default:
        return;
    }
  }
}
