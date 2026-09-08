"use client";

import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { useAssistantTransportRuntime } from "@assistant-ui/react";
import { messageConverter } from "./converter.js";
import {
  createInitialRuntimeState,
  fetchSessionSnapshot,
  type RuntimeState,
} from "./session-sync.js";

const DEFAULT_API = "/api/transport";

export { DEFAULT_API };

export type UseTransportOptions = {
  /** Transport endpoint. Defaults to the same-origin `/api/transport`. */
  api?: string;
  /** Extra request headers for the transport calls. */
  headers?: Record<string, string>;
  /** Called when a run finishes. */
  onFinish?: () => void;
  /**
   * Called when a run fails. The protocol-level default (marking the wire
   * state `error` and logging) always runs first; this callback is additive.
   */
  onError?: (
    error: Error,
    params: {
      commands: readonly unknown[];
      updateState: (updater: (state: RuntimeState) => RuntimeState) => void;
    },
  ) => void | Promise<void>;
};

/**
 * assistant-ui transport runtime over the transport-service, with the
 * session's history loaded on mount.
 *
 * History: the transport runtime only starts a request when the user sends a
 * message, so this hook fires a command-less probe on mount and imports the
 * folded snapshot into the thread. The backend reconciles every client
 * against its canonical transcript, so a fresh page (and a page reload)
 * always converges to the full history.
 *
 * Running state: the session's running flag is passed INTO the message
 * conversion (assistant-ui derives per-part status from it — getAutoStatus →
 * toMessagePartStatus). While the session is running, the trailing assistant
 * message is marked `running`, which is what makes an in-flight reasoning
 * part (streaming shimmer) and an executing tool-call part (no result yet →
 * spinner) render their running state. Without it, every message converts as
 * `complete` (and a message holding a result-less tool-call even becomes
 * `requires-action`), so tool/reasoning UIs pop in looking finished and
 * never animate while the backend is still working.
 */
export function useTransport(options: UseTransportOptions = {}): AssistantRuntime {
  const api = options.api ?? DEFAULT_API;

  const runtime = useAssistantTransportRuntime<RuntimeState>({
    api,
    protocol: "assistant-transport",
    headers: options.headers ?? {},
    initialState: createInitialRuntimeState(),
    converter: (state) => {
      const isRunning = state.status === "running";
      return {
        messages: messageConverter.toThreadMessages(Object.values(state.messages), isRunning),
        isRunning,
      };
    },
    onFinish: options.onFinish,
    onError: (error, params) => {
      // Protocol-level invariant: a failed run always ends `error` in the
      // wire state, no matter what a consumer's callback does.
      params.updateState((s) => ({ ...s, status: "error" as const }));
      console.error("[transport-client] run FAILED", error);
      return options.onError?.(error, params);
    },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchSessionSnapshot(api, createInitialRuntimeState(), null);
      if (cancelled || snapshot === null) return;
      const threadState = runtime.thread.getState();
      // If a send started while the probe was in flight, that run's own
      // reconcile already streamed the history — importing an older snapshot
      // here could clobber it.
      if (
        threadState.isRunning ||
        threadState.isLoading ||
        threadState.messages.length > 0
      ) {
        return;
      }
      runtime.thread.importExternalState(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, runtime]);

  return runtime;
}
