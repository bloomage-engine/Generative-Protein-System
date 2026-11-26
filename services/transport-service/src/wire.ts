import type {
  DeltaEffect,
  FoldState,
  Message,
  MessagePart,
  SessionState,
  StateDelta,
} from "@gps/transport";
import { foldState, sameMessages } from "@gps/transport";

/** Serialize a single state op into the assistant-transport SSE frame. */
export function encodeOp(op: WireOp): string {
  return `data: ${JSON.stringify({ type: "update-state", path: [], operations: [op] })}\n\n`;
}

/** A client-safe operation: `set`, or `append-text` at a string path. */
export interface WireOp {
  type: "set" | "append-text";
  path: string[];
  value: unknown;
}

const set = (path: string[], value: unknown): WireOp => ({ type: "set", path, value });
const appendText = (path: string[], value: string): WireOp => ({ type: "append-text", path, value });

/** The client state that travels in the request body (`state`). */
export interface ClaimedState {
  status: SessionState["status"];
  /** Claimed messages in the order the client holds them (order is significant). */
  messages: Message[];
}

export function parseClaimedState(body: { state?: unknown }): ClaimedState {
  const raw = (body.state ?? {}) as Record<string, unknown>;
  const status: SessionState["status"] =
    raw.status === "running" || raw.status === "error" ? raw.status : "idle";
  const messages: Message[] = [];
  const src = raw.messages;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const value of Object.values(src as Record<string, unknown>)) {
      const msg = normalizeClaimedMessage(value);
      if (msg) messages.push(msg);
    }
  }
  return { status, messages };
}

function normalizeClaimedMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.role !== "string") return null;
  const parts: MessagePart[] = Array.isArray(m.parts)
    ? (m.parts.filter((p) => p && typeof p === "object" && typeof (p as { type?: unknown }).type === "string") as MessagePart[])
    : [];
  return { id: m.id, role: m.role === "assistant" ? "assistant" : "user", parts };
}

function messagesToMap(messages: Message[]): Record<string, Message> {
  const map: Record<string, Message> = {};
  for (const m of messages) map[m.id] = m;
  return map;
}

/**
 * Folds adapter state deltas into client-safe `set` / `append-text` ops.
 *
 * The assistant-ui accumulator on the client rejects every op type except
 * `set` and `append-text`, so purely incremental deltas must be materialized
 * into client-safe ops here. The delta semantics themselves live in ONE module
 * — `foldState` in @gps/transport — shared with the adapters' own
 * canonical transcript folds. This builder keeps a `FoldState` mirror (seeded
 * from the state the client claimed) and formats each fold's `DeltaEffect`s
 * into ops, so the mirror is a mechanical projection of the delta stream.
 *
 * The mirror's state must stay PRIVATE: an adapter folds every delta onto its
 * canonical transcript before this builder folds it, and payload-bearing
 * deltas (add-message / add-part / update-message) carry references to the
 * adapter's live objects. Folding them here directly would re-apply mutations
 * the adapter's fold already made to the shared objects — doubling parts and
 * taking different `stream-text` branches than the client will (e.g. emitting
 * an `append-text` for a text part whose `parts-set` was never streamed), which
 * makes the client accumulator throw `Expected string at path [...]`. Every
 * delta is therefore deep-copied before folding, so each one applies exactly
 * once to state only this builder touches, and every emitted op matches what a
 * client that applied the previous ops can apply.
 *
 * `reconcile` deltas (yielded by the adapter at the start of every run) carry
 * the canonical transcript; when it differs from the client's claimed state we
 * stream a whole-message-map snapshot so stale/empty clients converge (this is
 * what makes history appear on initial load and after reloads).
 */
export class WireOpsBuilder {
  private readonly claimed: ClaimedState;
  private readonly mirror: FoldState;

  constructor(claimed: ClaimedState) {
    this.claimed = claimed;
    this.mirror = {
      status: claimed.status,
      messages: [...claimed.messages],
    };
  }

  fold(delta: StateDelta): WireOp[] {
    if (delta.type === "reconcile") return this.reconcile(delta);
    return foldState(this.mirror, structuredClone(delta)).flatMap((effect) => this.format(effect));
  }

  /** Reconcile: fold the canonical transcript, then emit only on drift. */
  private reconcile(delta: Extract<StateDelta, { type: "reconcile" }>): WireOp[] {
    const drift = !sameMessages(this.claimed.messages, delta.messages);
    // Adopt a private copy: foldState keeps the messages array by reference,
    // and the mirror must never share state with the adapter's live transcript.
    foldState(this.mirror, { ...delta, messages: structuredClone(delta.messages) });
    const ops: WireOp[] = [];
    if (drift) ops.push(set(["messages"], messagesToMap(this.mirror.messages)));
    if (this.claimed.status !== delta.status) ops.push(set(["status"], delta.status));
    return ops;
  }

  /**
   * Format one fold effect into client-safe ops. Effect shapes are chosen so
   * this stays a mechanical mapping: whole values are read from the folded
   * mirror, small scalars ride on the effect itself.
   */
  private format(effect: DeltaEffect): WireOp[] {
    switch (effect.type) {
      case "status":
        return [set(["status"], effect.status)];
      case "messages-replaced":
        return [set(["messages"], messagesToMap(this.mirror.messages))];
      case "message-added": {
        const msg = this.findMessage(effect.messageId);
        return msg ? [set(["messages", msg.id], msg)] : [];
      }
      case "parts-set": {
        const msg = this.findMessage(effect.messageId);
        return msg ? [set(["messages", msg.id, "parts"], msg.parts)] : [];
      }
      case "text-appended":
        return [
          appendText(["messages", effect.messageId, "parts", String(effect.partIndex), "text"], effect.appended),
        ];
      case "text-set":
        return [set(["messages", effect.messageId, "parts", String(effect.partIndex), "text"], effect.text)];
      case "role-set":
        return [set(["messages", effect.messageId, "role"], effect.role)];
      case "approval":
        return [set(["approval"], { id: effect.approvalId, kind: effect.kind, summary: effect.summary })];
      default: {
        const _exhaustive: never = effect;
        return [];
      }
    }
  }

  private findMessage(messageId: string): Message | undefined {
    return this.mirror.messages.find((m) => m.id === messageId);
  }
}
