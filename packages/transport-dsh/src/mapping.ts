import type { Message, MessagePart } from "@science-studio/transport";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { TurnEndReason } from "@deepseek-ai/dsh-session";

/**
 * Translate one dsh content-block array into Science Studio message parts.
 * Text and reasoning map 1:1; tool calls become a `tool-call` part carrying
 * the model's raw JSON arguments string. Image/file blocks and any
 * merge-extensible future block kinds are dropped: the transport seam has no
 * rendering for them yet, and silently skipping is safer than mangling.
 */
export function contentToParts(content: readonly ContentBlock[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        parts.push({ type: "reasoning", text: block.text });
        break;
      case "tool-call":
        parts.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          args: block.arguments,
        });
        break;
      default:
        // image / file / tool-result / unknown blocks: no seam rendering.
        break;
    }
  }
  return parts;
}

/** Concatenated text of every text block at any depth (tool results nest). */
export function extractResultText(content: readonly ContentBlock[]): string {
  const texts: string[] = [];
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === "text") texts.push(block.text);
      if (block.type === "tool-result") walk(block.content);
    }
  };
  walk(content);
  return texts.join("\n");
}

/** Find a message part by role index helpers used across the transcript. */
export function findToolCallPart(
  message: Message,
  callId: string,
): { part: Extract<MessagePart, { type: "tool-call" }>; index: number } | null {
  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    if (part && part.type === "tool-call" && part.id === callId) {
      return { part, index: i };
    }
  }
  return null;
}

/** Map a dsh `turn/end` reason to the terminal Science Studio session status. */
export function turnEndStatus(reason: TurnEndReason): "idle" | "error" {
  return reason.kind === "error" ? "error" : "idle";
}
