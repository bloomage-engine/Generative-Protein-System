import {
  AssistantTransportDecoder,
  AssistantMessageAccumulator,
  unstable_createInitialMessage,
} from "assistant-stream";
import { asAsyncIterableStream } from "assistant-stream/utils";
import type { ReadonlyJSONValue } from "assistant-stream/utils";
import type { Message } from "@science-studio/transport";

/**
 * The agent state the transport-service streams back as operations.
 * `messages` is keyed by id (the backend emits `set` ops at `messages[<id>]`).
 * Same shape as apps/web/lib/session-sync.ts — the wire contract lives in
 * AGENTS.md and must stay identical for every client.
 */
export type RuntimeState = {
  status: "idle" | "running" | "error";
  messages: Record<string, Message>;
};

/** The state of a freshly mounted client, before any history is loaded. */
export function createInitialRuntimeState(): RuntimeState {
  return { status: "idle", messages: {} };
}

/**
 * POST a command-less probe to the transport endpoint and fold the streamed
 * operations into the claimed state — exactly how the transport runtime
 * consumes responses. Returns the folded snapshot, or `null` when the request
 * failed or nothing was streamed.
 */
export async function fetchSessionSnapshot(
  api: string,
  claimed: RuntimeState,
  threadId: string | null,
): Promise<RuntimeState | null> {
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: [], state: claimed, threadId }),
  });
  if (!res.ok || !res.body) return null;

  try {
    const decoder = new AssistantTransportDecoder({ strict: true });
    const accumulator = new AssistantMessageAccumulator({
      // The wire state is plain JSON; the domain types just don't say so.
      initialMessage: unstable_createInitialMessage({
        unstable_state: claimed as unknown as ReadonlyJSONValue,
      }),
      strict: true,
    });
    let latest: RuntimeState | null = null;
    const stream = res.body.pipeThrough(decoder).pipeThrough(accumulator);
    for await (const chunk of asAsyncIterableStream(stream)) {
      latest = chunk.metadata.unstable_state as unknown as RuntimeState;
    }
    return latest;
  } catch (error) {
    console.error("[session-sync] failed to decode snapshot", error);
    return null;
  }
}
