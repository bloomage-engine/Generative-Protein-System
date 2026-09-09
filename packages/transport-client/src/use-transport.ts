"use client";

import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { useAssistantTransportRuntime } from "@assistant-ui/react";
import { messageConverter } from "./converter.js";
import {
  canImportThread,
  createInitialRuntimeState,
  fetchSessionSnapshot,
  type RuntimeState,
} from "./session-sync.js";
import { watchReconnect } from "./watch-loop.js";

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
 * assistant-ui transport runtime over the transport-service — the ONE session
 * hook every app uses. It mounts both standing consumers behind a single `api`
 * option:
 *
 * 1. History probe (mount): the transport runtime only starts a request when
 *    the user sends a message, so the hook fires a command-less probe on mount
 *    and imports the folded snapshot into the thread. The backend reconciles
 *    every client against its canonical transcript, so a fresh page (and a
 *    page reload) always converges to the full history.
 * 2. Standing watch: keeps a long-lived `${api}/watch` connection open and
 *    adopts each pushed canonical snapshot. Content can settle into the
 *    transcript without ever streaming over a client's run channel — remote
 *    turns (e.g. on the openclaw UI) never touch this process, and native
 *    command replies (e.g. `/status`) are written to history only AFTER the
 *    run's terminal frame — so the adapter re-pushes a snapshot at settle
 *    time, which is exactly what this consumer adopts.
 *
 * Both consumers share ONE guarded-import interlock (`canImportThread`):
 * `importExternalState` is a whole-replace with no versioning interlock, so
 * while a local run is active the run channel is the sole writer and imports
 * are skipped; when idle the import paths are the sole writers. The probe
 * additionally requires an empty thread, so an older snapshot fetched in
 * flight never clobbers a newer watch push.
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
  const base = api.replace(/\/+$/, "");

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

  // History probe (mount): fold one command-less request and import the
  // snapshot, unless a send (or a watch push) started while it was in flight.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchSessionSnapshot(base, createInitialRuntimeState(), null);
      if (cancelled || snapshot === null) return;
      const busy = (() => {
        try {
          const s = runtime.thread.getState();
          return !canImportThread(
            { isRunning: s.isRunning, isLoading: s.isLoading, messageCount: s.messages.length },
            true,
          );
        } catch {
          return true;
        }
      })();
      if (busy) return;
      runtime.thread.importExternalState(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, [base, runtime]);

  // Standing watch: keep the NDJSON connection open and adopt each pushed
  // canonical snapshot when the interlock allows.
  useEffect(() => {
    let closed = false;

    const isBusy = (): boolean => {
      try {
        const s = runtime.thread.getState();
        return !canImportThread(
          { isRunning: s.isRunning, isLoading: s.isLoading, messageCount: s.messages.length },
          false,
        );
      } catch {
        return true;
      }
    };

    const adopt = (snapshot: unknown): void => {
      if (isBusy()) return;
      if (!snapshot || typeof snapshot !== "object") return;
      // Whole-replace: the snapshot is the full cumulative transcript, so a
      // plain import converges the thread to the latest canonical state.
      try {
        runtime.thread.importExternalState(snapshot as RuntimeState);
      } catch (err) {
        console.warn("[watch] importExternalState failed", err);
      }
    };

    async function frameLoop(): Promise<void> {
      try {
        const res = await fetch(`${base}/watch`, {
          headers: { accept: "application/x-ndjson" },
        });
        if (!res.ok || !res.body) throw new Error(`watch ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const trimmed = line.trim();
            if (!trimmed) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              continue;
            }
            adopt(parsed);
          }
        }
      } catch {
        // Connection dropped or service unavailable — reconnect below.
      }
    }

    const handle = watchReconnect({
      isClosed: () => closed,
      // frameLoop never throws (failures are swallowed inside), so this always
      // settles when the connection drops/errors and the loop paces the retry.
      connect: async () => {
        await frameLoop();
      },
    });

    return () => {
      closed = true;
      handle.cancel();
    };
  }, [base, runtime]);

  return runtime;
}
