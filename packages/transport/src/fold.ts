import type { Id } from "@science-studio/record";
import type { Message, SessionState, StateDelta } from "./types.js";

/**
 * The fold target: the slice of session state that `StateDelta`s mutate.
 * Both the runtime adapter (its canonical transcript) and the transport-
 * service wire mirror fold onto this shape; a full `SessionState` is
 * structurally compatible, so adapters can pass their transcript directly.
 */
export interface FoldState {
  status: SessionState["status"];
  messages: Message[];
}

/**
 * What one fold did to the state — protocol-neutral change locations.
 *
 * Shapes are chosen so the wire projection in transport-service stays a
 * mechanical formatter: whole values (a new message, a replaced parts array)
 * are read by the caller from the mutated state after the fold, small scalars
 * (appended/replaced text, status, role, approval payload) ride on the effect
 * itself.
 */
export type DeltaEffect =
  | { type: "status"; status: SessionState["status"] }
  /** The whole ordered message list was replaced (`reconcile`). */
  | { type: "messages-replaced" }
  | { type: "message-added"; messageId: Id }
  /** The message's parts array was structurally replaced (a part was added or
   *  the array swapped wholesale). */
  | { type: "parts-set"; messageId: Id }
  /** The message's trailing text part grew by `appended`. */
  | { type: "text-appended"; messageId: Id; partIndex: number; appended: string }
  /** The text of the part at `partIndex` was replaced (text or reasoning). */
  | { type: "text-set"; messageId: Id; partIndex: number; text: string }
  | { type: "role-set"; messageId: Id; role: Message["role"] }
  /** A pure notice: nothing in the fold target carries approvals. */
  | { type: "approval"; approvalId: Id; kind: string; summary: string };

function findMessage(messages: Message[], messageId: string): Message | undefined {
  return messages.find((m) => m.id === messageId);
}

/**
 * Apply one delta to the fold state in place, returning the effects that
 * describe exactly what changed. This is the single authoritative definition
 * of `StateDelta` semantics — every mirror of a delta stream (an adapter's
 * canonical transcript, a wire projection's mirror) must fold through here so
 * they can never drift apart.
 *
 * Semantics pinned by architecture review (2026-09):
 * - deltas addressing an unknown message id are dropped (no-op, no effect);
 * - `append-text` always creates a NEW text part (`stream-text` is the op that
 *   grows the trailing text part);
 * - `reconcile` replaces the whole ordered list — content AND order. The
 *   caller must treat the delta's `messages` payload as single-consumer: the
 *   fold adopts the array by reference and later folds mutate it in place
 *   (adapters already yield a fresh `structuredClone` per snapshot);
 * - `stream-text` on a non-text tail (or no tail) starts a new text part, even
 *   with `replace: true`;
 * - `set-part-text` only applies to parts that carry `text` (text/reasoning);
 *   an out-of-range or non-text index is dropped;
 * - `update-message` with an empty patch (no `parts`, no `role`) is a no-op;
 * - `approval-required` mutates nothing — it surfaces as an `approval` effect.
 */
export function foldState(state: FoldState, delta: StateDelta): DeltaEffect[] {
  switch (delta.type) {
    case "session-status": {
      state.status = delta.status;
      return [{ type: "status", status: delta.status }];
    }
    case "reconcile": {
      state.status = delta.status;
      state.messages = delta.messages;
      return [{ type: "messages-replaced" }];
    }
    case "add-message": {
      state.messages.push(delta.message);
      return [{ type: "message-added", messageId: delta.message.id }];
    }
    case "update-message": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      const effects: DeltaEffect[] = [];
      if (delta.patch.parts !== undefined) {
        msg.parts = delta.patch.parts;
        effects.push({ type: "parts-set", messageId: msg.id });
      }
      if (delta.patch.role !== undefined) {
        msg.role = delta.patch.role;
        effects.push({ type: "role-set", messageId: msg.id, role: delta.patch.role });
      }
      return effects;
    }
    case "add-part": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      msg.parts.push(delta.part);
      return [{ type: "parts-set", messageId: msg.id }];
    }
    case "append-text": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      msg.parts.push({ type: "text", text: delta.text });
      return [{ type: "parts-set", messageId: msg.id }];
    }
    case "stream-text": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      const idx = msg.parts.length - 1;
      const last = idx >= 0 ? msg.parts[idx] : undefined;
      if (last && last.type === "text") {
        msg.parts[idx] = {
          ...last,
          text: delta.replace ? delta.text : (last.text ?? "") + delta.text,
        };
        return delta.replace
          ? [{ type: "text-set", messageId: msg.id, partIndex: idx, text: delta.text }]
          : [{ type: "text-appended", messageId: msg.id, partIndex: idx, appended: delta.text }];
      }
      msg.parts.push({ type: "text", text: delta.text });
      return [{ type: "parts-set", messageId: msg.id }];
    }
    case "set-part-text": {
      const msg = findMessage(state.messages, delta.messageId);
      if (!msg) return [];
      const part = msg.parts[delta.partIndex];
      if (!part || (part.type !== "text" && part.type !== "reasoning")) return [];
      msg.parts[delta.partIndex] = { ...part, text: delta.text };
      return [{ type: "text-set", messageId: msg.id, partIndex: delta.partIndex, text: delta.text }];
    }
    case "approval-required":
      return [{ type: "approval", approvalId: delta.approvalId, kind: delta.kind, summary: delta.summary }];
    default: {
      const _exhaustive: never = delta;
      return [];
    }
  }
}

/** Ordered content equality for two message lists — order is significant. */
export function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => messagesEqual(m, b[i]!));
}

function messagesEqual(a: Message, b: Message): boolean {
  if (a.id !== b.id || a.role !== b.role) return false;
  if (a.parts.length !== b.parts.length) return false;
  return a.parts.every((p, i) => JSON.stringify(p) === JSON.stringify(b.parts[i]!));
}
