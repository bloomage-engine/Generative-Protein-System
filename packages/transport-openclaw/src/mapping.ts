import type { EventFrame } from "@openclaw/gateway-client/browser";
import type { MessagePart } from "@gps/transport";
import { formatResultText, mergeToolResult } from "./tool-result.js";

/**
 * Pure mapping from gateway `chat` / `agent` frames into normalized
 * `MessagePart`s and `StateDelta`s. Ported from the reference openclaw
 * adapter's `events.ts` / `blocks.ts` and adapted to Generative Protein System's
 * `SessionState` shape (see docs/architecture.md §4 / §5).
 */

const CHAT_STATES = new Set(["delta", "final", "aborted", "error"]);

export function mapChatEvent(payload: Record<string, unknown>): {
  runId: string;
  status: "streaming" | "completed" | "aborted" | "error";
  message?: unknown;
  /** Incremental text chunk for `delta` events (`ChatDeltaEvent.deltaText`). */
  deltaText?: string;
  /** When true the delta replaces the streamed text instead of appending. */
  replace?: boolean;
  errorKind?: string;
  errorMessage?: string;
} | null {
  const state = payload.state;
  if (typeof state !== "string" || !CHAT_STATES.has(state)) return null;
  const runId = payload.runId;
  if (typeof runId !== "string") return null;
  const status =
    state === "delta"
      ? "streaming"
      : state === "final"
        ? "completed"
        : state === "aborted"
          ? "aborted"
          : "error";
  return {
    runId,
    status,
    message: payload.message,
    ...(typeof payload.deltaText === "string"
      ? { deltaText: payload.deltaText }
      : {}),
    ...(payload.replace === true ? { replace: true } : {}),
    ...(typeof payload.errorKind === "string" ? { errorKind: payload.errorKind } : {}),
    ...(typeof payload.errorMessage === "string" ? { errorMessage: payload.errorMessage } : {}),
  };
}

/** Normalize a live gateway `agent`/`tool` frame. */
export function mapToolEvent(
  frame: EventFrame,
  targetSessionKey?: string,
): {
  runId: string;
  phase: "start" | "result";
  toolCallId: string;
  toolName: string;
  args: unknown;
  resultText?: string;
  isError: boolean;
} | null {
  if (frame.event !== "agent") return null;
  const payload = (frame.payload ?? {}) as Record<string, unknown>;
  if (payload.stream !== "tool") return null;
  if (targetSessionKey !== undefined && payload.sessionKey !== targetSessionKey) return null;
  const runId = payload.runId;
  if (typeof runId !== "string") return null;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const toolCallId = data.toolCallId;
  const toolName = data.name ?? data.toolName;
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return null;
  if (data.phase === "start") {
    return { runId, phase: "start", toolCallId, toolName, args: data.args ?? {}, isError: false };
  }
  if (data.phase === "result") {
    const result = data.result;
    return {
      runId,
      phase: "result",
      toolCallId,
      toolName,
      args: {},
      resultText: formatResultText(result),
      isError: data.isError === true,
    };
  }
  return null;
}

/** Normalize a live gateway `agent`/`thinking` frame. */
export function mapThinkingEvent(
  frame: EventFrame,
  targetSessionKey?: string,
): { runId: string; text: string } | null {
  if (frame.event !== "agent") return null;
  const payload = (frame.payload ?? {}) as Record<string, unknown>;
  if (payload.stream !== "thinking") return null;
  if (targetSessionKey !== undefined && payload.sessionKey !== targetSessionKey) return null;
  const runId = payload.runId;
  if (typeof runId !== "string") return null;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const text = data.text;
  if (typeof text !== "string") return null;
  return { runId, text };
}

type RawBlock = Record<string, unknown>;

const TOOL_CALL_TYPES = new Set(["toolcall", "tool-call", "tool_call", "tooluse", "tool_use", "tool-use", "function_call"]);
const TOOL_RESULT_TYPES = new Set(["toolresult", "tool-result", "tool_result"]);
const THINKING_TYPES = new Set(["thinking", "reasoning", "chain_of_thought"]);

function normType(t: unknown): string | undefined {
  return typeof t === "string" ? t.trim().toLowerCase().replace(/\s+/g, "") : undefined;
}

function firstString(b: RawBlock, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function readCallArgs(b: RawBlock): { args: unknown } {
  for (const key of ["arguments", "args", "input", "params"] as const) {
    const raw = b[key];
    if (raw === undefined) continue;
    if (typeof raw === "string") {
      try {
        return { args: JSON.parse(raw) as unknown };
      } catch {
        return { args: raw };
      }
    }
    return { args: raw };
  }
  return { args: {} };
}

function toToolCallPart(b: RawBlock): MessagePart | null {
  const id = firstString(b, ["id", "toolCallId", "tool_call_id", "callId", "call_id"]);
  const name = firstString(b, ["name", "toolName", "tool_name", "tool"]);
  if (!id || !name) return null;
  const { args } = readCallArgs(b);
  const argsText = typeof args === "string" ? args : args !== undefined ? JSON.stringify(args) : "";
  const result = b.result !== undefined ? formatResultText(b.result) : undefined;
  const isError = b.isError === true || b.error === true;
  const part: MessagePart = { type: "tool-call", id, name, args: argsText };
  if (result !== undefined) part.result = result;
  if (isError) part.isError = true;
  return part;
}

/**
 * Parse a gateway message (string or block-array `content`) into our
 * normalized `MessagePart`s. Ported from `parseMessageParts`.
 */
export function parseParts(message: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = [];
  const legacyText = typeof message.text === "string" ? message.text : "";
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];

  const contentText: string[] = [];
  for (const block of content) {
    const b = (block ?? {}) as RawBlock;
    const type = normType(b.type);
    if (type === undefined || type === "text") {
      if (typeof b.text === "string" && b.text) contentText.push(b.text);
      continue;
    }
    if (THINKING_TYPES.has(type)) {
      const text = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
      if (text) parts.push({ type: "reasoning", text });
      continue;
    }
    if (TOOL_CALL_TYPES.has(type)) {
      const call = toToolCallPart(b);
      if (call) parts.push(call);
      continue;
    }
    if (TOOL_RESULT_TYPES.has(type)) {
      const id = firstString(b, ["toolCallId", "tool_call_id", "id", "callId", "call_id"]);
      if (!id) continue;
      const text = formatResultText(b.content ?? b.result);
      const isError = b.isError === true || b.error === true;
      if (mergeToolResult(parts, id, text, isError)) continue;
      if (text) parts.push({ type: "text", text });
      continue;
    }
  }

  if (parts.length === 0 && contentText.length === 0 && legacyText) contentText.push(legacyText);
  for (const t of contentText) parts.push({ type: "text", text: t });

  // Legacy top-level toolCalls array.
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  for (const raw of toolCalls) {
    if (raw && typeof raw === "object") {
      const call = toToolCallPart(raw as RawBlock);
      if (call) parts.push(call);
    }
  }
  return parts;
}
