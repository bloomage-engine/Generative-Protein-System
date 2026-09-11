import type { Message } from "@science-studio/transport";
import { sameConversation } from "@science-studio/transport";
import { parseParts } from "./mapping.js";
import { attachHistoryToolResult, TOOL_RESULT_ROLES } from "./tool-result.js";

/**
 * Pure reconciliation policy between the adapter's canonical transcript and
 * the gateway's `chat.history` — the decision previously embedded inside
 * `SessionTranscript.syncFromHistory`. Kept dependency-free of the transcript
 * so the subtle keep/rebuild/reset guards are directly unit-testable without
 * a live transcript lifecycle (docs/adr/0002: the gateway owns the
 * conversation, but Science Studio owns this record).
 */

/**
 * Normalize `chat.history` rows into transcript messages (system rows and
 * non-object rows excluded). Rows without a gateway id get positional
 * `hist-<n>` ids, counting up from `offset` over accepted messages only.
 * `toolResult` rows are not messages: their result is merged into the
 * matching `tool-call` part of the latest assistant message (gateway
 * transcripts persist tool output as its own row, unlike live events).
 */
export function parseHistoryRows(rows: readonly unknown[], offset = 0): Message[] {
  const messages: Message[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
    // Skip non-conversational rows (gateway system "reset" frames, approvals…).
    if (role === "system") continue;
    if (TOOL_RESULT_ROLES.has(role)) {
      attachHistoryToolResult(messages, m);
      continue;
    }
    if (role !== "" && role !== "user" && role !== "assistant") continue;
    const id = typeof m.id === "string" ? m.id : `hist-${offset + messages.length}`;
    messages.push({
      id,
      role: role === "assistant" ? "assistant" : "user",
      parts: parseParts(m),
    });
  }
  return messages;
}

/** What the transcript should do given the gateway's current history. */
export type HistorySyncDecision =
  /** Already converged (equal), or the gateway simply lags the local tail. */
  | { action: "keep" }
  /** The gateway knows more (or something different): adopt its rows. */
  | { action: "rebuild"; messages: Message[] }
  /** The gateway history was emptied: clear the local transcript. */
  | { action: "reset" };

export interface HistorySyncInput {
  /** True while an assistant turn is being assembled — never touch it (the
   *  gateway lags the live events and a rebuild would wipe the partially
   *  assembled assistant message). */
  inFlight: boolean;
  /** The transcript's current ordered messages (content-prefix checked). */
  messages: readonly Message[];
  /** Raw `chat.history` rows from the gateway. */
  rows: readonly unknown[];
}

/**
 * Decide how the canonical transcript should converge with the gateway's
 * current history. The gateway owns the conversation and is not the only
 * writer: turns can arrive from other clients (e.g. the openclaw UI) between
 * two of our runs, and their user rows never pass through this process —
 * seeding only when empty would strand the transcript on stale rows and
 * reconcile would keep serving a transcript missing those user turns (with
 * orphan assistant messages where streaming events happened to leak in). So
 * whenever the parsed history is not a content-prefix of the current
 * transcript, the transcript is rebuilt from the gateway rows.
 *
 * Guards: an in-flight run is never touched; an equal or gateway-lagging
 * transcript keeps its local messages and ids (no reconcile churn after every
 * local run); clearing is guarded — an empty gateway history only counts as a
 * reset when the transcript holds >= 2 messages, so a single never-persisted
 * message (failed `chat.send`) survives.
 */
export function decideHistorySync(input: HistorySyncInput): HistorySyncDecision {
  if (input.inFlight) return { action: "keep" };
  const gateway = parseHistoryRows(input.rows);
  if (gateway.length === 0) {
    return input.messages.length >= 2 ? { action: "reset" } : { action: "keep" };
  }
  if (input.messages.length === 0) return { action: "rebuild", messages: gateway };
  // Gateway rows are a content-prefix of the transcript: already converged
  // (equal), or the gateway simply lags our not-yet-persisted tail. Keep. The
  // shared `sameConversation` rule ignores volatile ids and client-side file
  // chips, and compares `role` (the previous local signature did not).
  if (gateway.length <= input.messages.length) {
    if (sameConversation(gateway, input.messages.slice(0, gateway.length))) {
      return { action: "keep" };
    }
  }
  // Otherwise the gateway knows more (or something different) than we do: it
  // wins. Rebuild so the next reconcile converges clients — including user
  // turns that arrived remotely — onto the gateway conversation.
  return { action: "rebuild", messages: gateway };
}
