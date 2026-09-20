"use client";

import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { useAssistantTransportRuntime } from "@assistant-ui/react";
import { messageConverter, pendingUserMessages } from "./converter.js";
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
  /**
   * The Project whose Session this runtime drives. Carried on every request
   * (probe, sends, watch); omitted → the service's default Project.
   */
  projectId?: string | null;
  /**
   * The Session (a record-owned id) to load and drive. `null`/omitted → the
   * runtime's own default session (the single-session mount probe).
   */
  threadId?: string | null;
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
 *
 * IMPORTANT — the owning component must never re-render. Assistant-ui rebuilds
 * its internal thread-list adapter on every invocation of
 * `useAssistantTransportRuntime`, and on a re-render the library reads the new
 * adapter identity as an adapter swap: it tears the active thread runtime down
 * and starts an empty one, wiping the transcript. The mount probe does not
 * re-run (its effect deps are stable), so the conversation stays blank until a
 * page reload. Keep the hook's component state-free and memoized, and hold UI
 * state in a child (see `apps/web/app/page.tsx`).
 */
export function useTransport(options: UseTransportOptions = {}): AssistantRuntime {
  const api = options.api ?? DEFAULT_API;
  const base = api.replace(/\/+$/, "");
  const projectId = options.projectId ?? null;
  const threadId = options.threadId ?? null;
  // The scope travels in the URL so it also reaches assistant-ui's OWN send
  // requests (we do not build their body); the service reads it from the query
  // when the body does not carry it.
  const scopedApi = withScope(api, projectId, threadId);

  const runtime = useAssistantTransportRuntime<RuntimeState>({
    api: scopedApi,
    protocol: "assistant-transport",
    headers: options.headers ?? {},
    initialState: createInitialRuntimeState(),
    converter: (state, { pendingCommands }) => {
      const isRunning = state.status === "running";
      const stateMessages = Object.values(state.messages);
      // The send is held in transit until the server's first frame, and the
      // state only gains the user's row when the server echoes it — so a
      // just-sent message is invisible to the state. Render the un-echoed
      // pending sends as optimistic stand-ins so the user sees it immediately
      // (they dedupe out the moment the echo lands in the state).
      const messages = [...stateMessages, ...pendingUserMessages(stateMessages, pendingCommands)];
      return {
        messages: messageConverter.toThreadMessages(messages, isRunning),
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
  // The request is aborted on unmount: the response is a stream, and a stream
  // nobody is reading any more must not hold a connection (see the watch below).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const snapshot = await fetchSessionSnapshot(
        scopedApi,
        createInitialRuntimeState(),
        threadId,
        projectId,
        controller.signal,
      );
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
      controller.abort();
    };
  }, [scopedApi, threadId, projectId, runtime]);

  // Standing watch: keep the NDJSON connection open and adopt each pushed
  // canonical snapshot when the interlock allows.
  useEffect(() => {
    let closed = false;
    // The watch stream NEVER ends by itself, so unmounting must abort it — a
    // connection left open here is never reused: the browser allows ~6 per
    // origin over HTTP/1.1, and every scope change remounts this runtime (twice
    // per mount under StrictMode). Once they are all orphaned, NO request to
    // this origin can start any more — the session list, the file listing and
    // the probe all queue forever, and the workbench looks frozen
    // (docs/adr/0009). `handle.cancel()` alone only stops reconnecting.
    const controller = new AbortController();

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
        const res = await fetch(`${base}/watch${watchQuery(projectId, threadId)}`, {
          headers: { accept: "application/x-ndjson" },
          signal: controller.signal,
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
      // Release the socket NOW: the reader above is parked on a stream that will
      // never deliver another byte, so without this the connection outlives the
      // runtime that owns it.
      controller.abort();
    };
  }, [base, projectId, threadId, runtime]);

  return runtime;
}

/** Append the Project/Session scope to a transport URL (sends included). */
function withScope(api: string, projectId: string | null, threadId: string | null): string {
  const qs = scopeParams(projectId, threadId);
  if (!qs) return api;
  return `${api}${api.includes("?") ? "&" : "?"}${qs}`;
}

/** The watch endpoint's query (its scope is always explicit). */
function watchQuery(projectId: string | null, threadId: string | null): string {
  const qs = scopeParams(projectId, threadId);
  return qs ? `?${qs}` : "";
}

function scopeParams(projectId: string | null, threadId: string | null): string {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (threadId) params.set("threadId", threadId);
  return params.toString();
}
