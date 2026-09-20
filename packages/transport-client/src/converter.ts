"use client";

import { unstable_createMessageConverter } from "@assistant-ui/react";
import type { AssistantTransportCommand } from "@assistant-ui/react";
import type { Message, MessagePart } from "@science-studio/transport";

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toArgs(value: string): Record<string, unknown> {
  const parsed = tryParse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Map one wire `MessagePart` to assistant-ui's content-part shape. */
export function partToContent(part: MessagePart): any {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call": {
      const base = {
        type: "tool-call" as const,
        toolCallId: part.id,
        toolName: part.name,
        args: toArgs(part.args),
        argsText: part.args,
      };
      if (part.result !== undefined) return { ...base, result: part.result };
      if (part.isError) return { ...base, isError: true };
      return base;
    }
    case "artifact":
      // Rendered by the app's `File` component (the thread maps the `file` part
      // type onto it). `data` is the artifact id, so this is a chip with no
      // download link — a workspace-backed `file` part (Phase 2) carries a path.
      return {
        type: "file",
        filename: part.name,
        mimeType: "application/octet-stream",
        data: part.artifactId,
        sourceType: "id",
      };
    case "file":
      // A workspace file the agent produced or referenced: `data` is its
      // workspace path, which the app resolves through the workspace API.
      return {
        type: "file",
        filename: part.name,
        mimeType: part.mime ?? "application/octet-stream",
        data: part.path,
        sourceType: "id",
      };
  }
}

/**
 * Shared converter: a domain `Message` → assistant-ui thread message. Deliberately
 * not in the package's public surface — consumers go through `useTransport`,
 * which owns the conversion and passes the session's running flag into it.
 */
export const messageConverter = unstable_createMessageConverter((message: Message) => ({
  role: message.role,
  content: message.parts.map(partToContent),
}));

// -- Optimistic pending sends ------------------------------------------------

type AddMessageCommand = Extract<AssistantTransportCommand, { type: "add-message" }>;

/**
 * The `@` mention directives the transport-service lifts out of sent text —
 * the SAME grammar as its `parseWorkspaceMentions` (which strips only
 * `file`/`directory` and collapses the remaining spaces), so a fingerprint
 * computed on the SENT text still matches the fingerprint of the ECHOED one.
 */
const LIFTED_DIRECTIVE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
const LIFTED_TYPES = new Set(["file", "directory"]);

function mentionFreeText(text: string): string {
  let remaining = "";
  let lastIndex = 0;
  let lifted = 0;
  for (const match of text.matchAll(LIFTED_DIRECTIVE)) {
    if (!LIFTED_TYPES.has(match[1]!)) continue;
    const index = match.index!;
    remaining += text.slice(lastIndex, index);
    lifted++;
    lastIndex = index + match[0].length;
  }
  if (lifted === 0) return text;
  return (remaining + text.slice(lastIndex)).replace(/[ \t]{2,}/g, " ").trim();
}

/** A user message's dedup key: its text parts, mention directives removed. */
function userTextKey(parts: readonly { type: string; text?: string }[]): string {
  return mentionFreeText(parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\u0001"));
}

/** A stable id for an optimistic stand-in message (content-derived). */
function stablePendingId(key: string, sourceId?: string | null): string {
  if (sourceId) return `pending-${sourceId}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h << 5) + h) ^ key.charCodeAt(i)) >>> 0;
  return `pending-${h.toString(36)}`;
}

/**
 * Pending user `add-message` commands the wire state does not carry yet, as
 * domain `Message`s. The transport runtime holds a send in transit until the
 * server's first frame, and the state only gains the user's own row when the
 * SERVER echoes it (under a server-minted id), so an un-echoed send is invisible
 * to the state — these stand-ins are what render it immediately. A command
 * already echoed in the state is skipped (dedup on the mention-free text), and
 * only text parts are carried: the domain `MessagePart` union has no image, and
 * `partToContent` maps only domain parts.
 */
export function pendingUserMessages(
  stateMessages: readonly Message[],
  pendingCommands: readonly AssistantTransportCommand[],
): Message[] {
  const seen = new Set(stateMessages.map((m) => (m.role === "user" ? userTextKey(m.parts) : null)).filter((k) => k !== null));
  const out: Message[] = [];
  for (const command of pendingCommands) {
    if (command.type !== "add-message") continue;
    const message: AddMessageCommand["message"] = command.message;
    if (message.role !== "user") continue;
    const parts = message.parts.filter(
      (p): p is { type: "text" } & { text: string } => p.type === "text" && typeof p.text === "string",
    );
    if (parts.length === 0) continue;
    const key = userTextKey(parts);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: stablePendingId(key, command.sourceId),
      role: "user",
      parts: parts.map((p) => ({ type: "text", text: p.text })),
    });
  }
  return out;
}
