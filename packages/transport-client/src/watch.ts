"use client";

import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { RuntimeState } from "./session-sync.js";
import { DEFAULT_API } from "./use-transport.js";
import { watchReconnect } from "./watch-loop.js";

/**
 * Standing watch consumer: keeps a long-lived NDJSON connection to
 * `${api}/watch` open and folds each pushed `RuntimeState` snapshot into the
 * thread via `runtime.thread.importExternalState`.
 *
 * Why a live consumer is required: the gateway owns the conversation and is
 * not the only writer, so content can settle into the canonical transcript
 * without ever streaming over a client's run channel — native command replies
 * (e.g. `/status`) are written to `chat.history` only AFTER the run's terminal
 * frame, and remote turns (openclaw TUI/UI) never touch this process. The
 * adapter converges the transcript at settle time and re-pushes a snapshot to
 * watchers, which is exactly what this hook adopts.
 *
 * Ordering invariant: `importExternalState` is a whole-replace and assistant-ui
 * provides no versioning/interlock between it and an in-flight send-run's SSE
 * stream. We guard with the same check the mount probe uses — while a local run
 * is active (`isRunning`/`isLoading`) we skip imports, leaving the run channel
 * as the sole writer; when idle the watch is the sole writer. No version
 * counter is needed in `RuntimeState` because the two writers are never
 * concurrent under this guard.
 */
export function useTransportWatch(
  runtime: AssistantRuntime,
  api: string = DEFAULT_API,
): void {
  useEffect(() => {
    let closed = false;

    const isLocallyBusy = (): boolean => {
      try {
        const s = runtime.thread.getState();
        return Boolean(s.isRunning || s.isLoading);
      } catch {
        return false;
      }
    };

    const adopt = (snapshot: unknown): void => {
      if (isLocallyBusy()) return;
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
        const res = await fetch(`${api.replace(/\/+$/, "")}/watch`, {
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
  }, [api, runtime]);
}
