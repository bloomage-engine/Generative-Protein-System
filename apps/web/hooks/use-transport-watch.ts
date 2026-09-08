"use client";

import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { RuntimeState } from "@/lib/session-sync";

/**
 * Standing watch consumer: keeps a long-lived NDJSON connection to
 * `/api/transport/watch` open and folds each pushed `RuntimeState` snapshot
 * into the thread via `runtime.thread.importExternalState` — so an open
 * browser adopts remote assistant replies without a page refresh.
 *
 * Ordering invariant: `importExternalState` is a whole-replace and assistant-ui
 * provides no versioning/interlock between it and an in-flight send-run's SSE
 * stream. We guard with the same check `app/page.tsx` uses on mount — while a
 * local run is active (`isRunning`/`isLoading`) we skip imports, leaving the
 * run channel as the sole writer; when idle the watch is the sole writer.
 * No version counter is needed in `RuntimeState` because the two writers are
 * never concurrent under this guard.
 */
export function useTransportWatch(api: string, runtime: AssistantRuntime): void {
  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
        const res = await fetch(`${api.replace(/\/$/, "")}/watch`, {
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

    async function start(): Promise<void> {
      while (!closed) {
        await frameLoop();
        if (closed) break;
        reconnectTimer = setTimeout(() => void start(), 2000);
      }
    }

    void start();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [api, runtime]);
}
