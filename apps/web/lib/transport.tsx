"use client";

import {
  unstable_createMessageConverter,
  useAssistantTransportRuntime,
} from "@assistant-ui/react";
import type { Message, MessagePart } from "@science-studio/transport";
import { createInitialRuntimeState, type RuntimeState } from "@/lib/session-sync";

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

function partToContent(part: MessagePart): any {
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
      return { type: "text", text: `[artifact: ${part.name}]` };
  }
}

const messageConverter = unstable_createMessageConverter((message: Message) => ({
  role: message.role,
  content: message.parts.map(partToContent),
}));

export function useTransportRuntime() {
  const runtime = useAssistantTransportRuntime<RuntimeState>({
    api: process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport",
    protocol: "assistant-transport",
    headers: {},
    initialState: createInitialRuntimeState(),
    converter: (state) => ({
      messages: messageConverter.toThreadMessages(Object.values(state.messages)),
      isRunning: state.status === "running",
    }),
    onFinish: () => console.log("[transport] run FINISHED"),
    onError: (error, { updateState }) => {
      updateState((s) => ({ ...s, status: "error" as const }));
      console.error("[transport] error", error);
    },
  });
  return runtime;
}
