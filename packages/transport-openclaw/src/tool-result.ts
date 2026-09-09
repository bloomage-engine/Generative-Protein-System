import type { Message, MessagePart } from "@science-studio/transport";

/**
 * Pure tool-result vocabulary + resolution shared by every source that
 * attaches a tool's output to its `tool-call` part. Invariant: ONE `tool-call`
 * part per `toolCallId` — the result is merged into the first matching part,
 * never appended as a duplicate.
 *
 * Sources differ only in WHERE to look and WHAT to do when nothing matches,
 * both of which stay at the call site:
 * - `chat.history` rows (`attachHistoryToolResult`): back-scan the whole
 *   transcript for the latest assistant message holding the part; an unmatched
 *   result row is dropped (the gateway transcript persists tool output as its
 *   own row).
 * - inline content blocks (`parseParts` in mapping.ts): search within the
 *   parts already parsed in the same message; an unmatched result becomes a
 *   standalone text part.
 * - live gateway tool events (`applyToolPart`): the same locate primitive; the
 *   part is created on `start` and later lifecycle fields are merged by the
 *   transcript, not here.
 */

/** `chat.history` row roles that carry a tool result instead of a message. */
export const TOOL_RESULT_ROLES = new Set(["toolresult", "tool_result", "tool-result"]);

/** Flatten a gateway tool-result payload into a readable string. */
export function formatResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) =>
        typeof b === "string" ? b : b && typeof b === "object" ? ((b as { text?: unknown }).text ?? "") : "",
      )
      .filter((v): v is string => typeof v === "string")
      .join("\n");
  }
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (content !== undefined) {
      const text = formatResultText(content);
      if (text.trim()) return text;
    }
  }
  return JSON.stringify(result);
}

export function findToolCallIndex(parts: readonly MessagePart[], toolCallId: string): number {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.type === "tool-call" && p.id === toolCallId) return i;
  }
  return -1;
}

/**
 * Attach `text` (and `isError` when true) to the first `tool-call` part with
 * id `toolCallId`, replacing it in place. Returns whether a part matched; the
 * caller decides what an unmatched result means (drop vs text fallback). An
 * existing `isError` flag survives a non-error merge (errors are only ever
 * added, never cleared).
 */
export function mergeToolResult(
  parts: MessagePart[],
  toolCallId: string,
  text: string,
  isError: boolean,
): boolean {
  const idx = findToolCallIndex(parts, toolCallId);
  if (idx === -1) return false;
  const part = parts[idx] as Extract<MessagePart, { type: "tool-call" }>;
  parts[idx] = {
    ...part,
    result: text,
    ...(isError ? { isError: true } : {}),
  };
  return true;
}

/**
 * Attach one `chat.history` tool-result row to the transcript it belongs to:
 * the row carries no own message, so its output is merged into the matching
 * `tool-call` part of the LATEST assistant message that holds it. Unmatched
 * rows are dropped (the gateway transcript is authoritative; a stale row has
 * no rendering).
 */
export function attachHistoryToolResult(messages: Message[], row: Record<string, unknown>): void {
  const toolCallId =
    typeof row.toolCallId === "string"
      ? row.toolCallId
      : typeof row.tool_call_id === "string"
        ? row.tool_call_id
        : undefined;
  if (!toolCallId) return;
  const text = formatResultText(row.content ?? row.result ?? row.text);
  const isError = row.isError === true;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (mergeToolResult(messages[i]!.parts, toolCallId, text, isError)) return;
  }
}
