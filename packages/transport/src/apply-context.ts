/**
 * The transcript primitives behind `ApplyContext`.
 *
 * `SessionRuntime` builds one context per `apply` call, and a behavior test
 * builds one directly with `createApplyContext` — so an adapter's event→delta
 * mapping is exercised against THE merge rules instead of a copy of them. The
 * copy had already drifted: it merged a `tool/result` but not the later `args`,
 * so the mapping was verified against a weaker rule than the one that ships.
 * There is one implementation of each rule and both callers share it — a
 * behavior test cannot assert a transcript the runtime would never build.
 *
 * Not a port: nothing varies across this seam. `createApplyContext` is the
 * constructor for a type the kit already publishes, which is what makes
 * `SessionBehavior.apply` testable without a runtime (docs/adr/0005).
 */
import type { Id } from "@gps/record";
import type { Message, MessagePart, SessionState, StateDelta } from "./types.js";
import { foldState } from "./fold.js";
import type { RunFlow } from "./run-flow.js";
import type { ApplyContext, RunControl, ToolCallUpdate } from "./session-runtime.js";

/**
 * The mutation primitives over ONE canonical transcript. `flow` is passed per
 * call: a delta is always folded into the transcript, and pushed to a flow only
 * when one is draining (an event outside a run has none).
 */
export interface TranscriptOps {
  /** Fold a delta onto the transcript AND fan it out to the in-flight flow. */
  emit(flow: RunFlow | null, delta: StateDelta): void;
  /** Find-or-create a message keyed by `id`, emitting `add-message` when new. */
  ensureMessage(flow: RunFlow | null, id: Id, role: Message["role"]): Message;
  /** The one `tool-call`-part-per-id merge rule (create on start, merge later). */
  mergeToolCall(flow: RunFlow | null, update: ToolCallUpdate): void;
}

export function createTranscriptOps(state: SessionState): TranscriptOps {
  const emit = (flow: RunFlow | null, delta: StateDelta): void => {
    // One fold (foldState) is the single source of delta semantics; the push to
    // the client is conditional on an attached flow.
    foldState(state, delta);
    flow?.push(delta);
  };

  const ensureMessage = (flow: RunFlow | null, id: Id, role: Message["role"]): Message => {
    const existing = state.messages.find((m) => m.id === id);
    if (existing) return existing;
    emit(flow, { type: "add-message", message: { id, role, parts: [] } });
    return state.messages.find((m) => m.id === id)!;
  };

  const mergeToolCall = (flow: RunFlow | null, update: ToolCallUpdate): void => {
    const message = state.messages.find((m) => m.id === update.messageId);
    if (!message) return;
    const index = findToolCallIndex(message.parts, update.toolCallId);
    if (index === -1) {
      // No part yet: create it, but only with a name (a start event).
      if (update.name === undefined) return;
      const part: Extract<MessagePart, { type: "tool-call" }> = {
        type: "tool-call",
        id: update.toolCallId,
        name: update.name,
        args: update.args ?? "",
      };
      if (update.result !== undefined) part.result = update.result;
      if (update.isError) part.isError = true;
      emit(flow, { type: "add-part", messageId: message.id, part });
      return;
    }
    // Same tool, later lifecycle event: merge in place, never a duplicate.
    const existing = message.parts[index] as Extract<MessagePart, { type: "tool-call" }>;
    const next = [...message.parts];
    next[index] = {
      ...existing,
      ...(update.args ? { args: existing.args || update.args } : {}),
      ...(update.result !== undefined ? { result: update.result } : {}),
      ...(update.isError ? { isError: true } : {}),
    };
    emit(flow, { type: "update-message", messageId: message.id, patch: { parts: next } });
  };

  return { emit, ensureMessage, mergeToolCall };
}

function findToolCallIndex(parts: readonly MessagePart[], toolCallId: Id): number {
  return parts.findIndex((p) => p.type === "tool-call" && p.id === toolCallId);
}

export interface ApplyContextOptions<E> {
  /** The Session key the events are attributed to. Defaults to `""`. */
  sessionKey?: string;
  /**
   * The Run this context belongs to. Defaults to none — which is the ordinary
   * case for a behavior test, and the SAME shape `SessionRuntime` builds for an
   * event that arrived with no local run.
   */
  run?: RunControl<E> | null;
}

/**
 * An `ApplyContext` over a transcript the caller owns, for driving a
 * `SessionBehavior.apply` without a runtime. Deltas fold into `state` and are
 * pushed nowhere (there is no flow); `reportRunId` records nothing (there is no
 * Run bookkeeping) — a test that needs either drives a real `SessionRuntime`.
 */
export function createApplyContext<E = never>(
  state: SessionState,
  options: ApplyContextOptions<E> = {},
): ApplyContext<E> {
  const ops = createTranscriptOps(state);
  const run = options.run ?? null;
  return {
    sessionKey: options.sessionKey ?? "",
    state,
    emit: (delta) => ops.emit(null, delta),
    ensureMessage: (id, role) => ops.ensureMessage(null, id, role),
    mergeToolCall: (update) => ops.mergeToolCall(null, update),
    reportRunId: () => {},
    get targetRunId() {
      return run?.targetRunId ?? null;
    },
    run,
  };
}
