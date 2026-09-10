"use client";

import { unstable_createMessageConverter } from "@assistant-ui/react";
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
