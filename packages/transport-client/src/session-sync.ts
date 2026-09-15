"use client";

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
 * This is the single source of truth for the transport runtime's state shape
 * (the wire contract lives in AGENTS.md).
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
 * operations into the claimed state, mirroring exactly how the transport
 * runtime itself consumes responses. Returns the folded snapshot, or `null`
 * when the request failed, was aborted, or nothing streamed.
 *
 * `signal` exists so the caller can release the connection on unmount: the
 * response is a stream, so an abandoned one pins a connection until the server
 * happens to end it (a scope change remounts the runtime; docs/adr/0009).
 */
export async function fetchSessionSnapshot(
  api: string,
  claimed: RuntimeState,
  threadId: string | null,
  projectId?: string | null,
  signal?: AbortSignal,
): Promise<RuntimeState | null> {
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [],
        state: claimed,
        threadId,
        ...(projectId ? { projectId } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !res.body) return null;

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
    // An abort is the CALLER releasing the connection on unmount, not a failure.
    if (!(error instanceof Error && error.name === "AbortError")) {
      console.error("[session-sync] snapshot request failed", error);
    }
    return null;
  }
}

/** The thread-state slice the import interlock reads. */
export interface ThreadBusyState {
  isRunning: boolean;
  isLoading: boolean;
  /** Number of messages currently in the thread. */
  messageCount: number;
}

/**
 * The guarded-import rule shared by the mount probe and the standing watch.
 * `importExternalState` is a whole-replace and assistant-ui provides no
 * versioning/interlock between it and an in-flight send-run's SSE stream, so
 * imports are skipped while a local run is active (`isRunning`/`isLoading`) —
 * the run channel is the sole writer then, the import paths the sole writer
 * when idle. The probe additionally requires an EMPTY thread: its snapshot
 * was fetched in flight and may be older than a watch push that already
 * landed, and importing it would clobber the newer state.
 */
export function canImportThread(state: ThreadBusyState, requireEmpty: boolean): boolean {
  if (state.isRunning || state.isLoading) return false;
  if (requireEmpty && state.messageCount > 0) return false;
  return true;
}
