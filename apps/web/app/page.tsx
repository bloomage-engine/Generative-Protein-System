"use client";

import { useEffect } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { useTransportRuntime } from "@/lib/transport";
import {
  createInitialRuntimeState,
  fetchSessionSnapshot,
} from "@/lib/session-sync";

/**
 * Conversation page.
 *
 * The chat UI is the Thread component registered from the assistant-ui
 * registry (https://www.assistant-ui.com/docs/installation) —
 * `components/assistant-ui/elements/thread.aui`. Only the runtime/provider
 * wiring below is Science Studio's: assistant-ui's `useAssistantTransportRuntime`
 * over the transport-service.
 */
export default function Home() {
  const runtime = useTransportRuntime();

  useEffect(() => {
    // Load the session's history on first mount. The transport runtime only
    // starts a request when the user sends a message, so we fire a command-less
    // probe and import the returned snapshot into the runtime. The backend
    // reconciles every client against its canonical transcript on each request,
    // so a fresh page (and a page reload) always converges to the full history.
    let cancelled = false;
    const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
    void (async () => {
      const snapshot = await fetchSessionSnapshot(
        api,
        createInitialRuntimeState(),
        null,
      );
      if (cancelled || snapshot === null) return;
      const threadState = runtime.thread.getState();
      // If a send started while the probe was in flight, that run's own
      // reconcile already streams the history — importing an older snapshot
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
  }, [runtime]);

  return (
    <main className="flex h-svh flex-col">
      <header className="flex items-baseline gap-3 border-b border-border/70 px-5 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Science Studio</h1>
        <p className="text-sm text-muted-foreground">
          Research-agent platform for computational life-science R&amp;D — a
          session with the agent over assistant-ui&apos;s assistant-transport
          protocol.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread />
        </AssistantRuntimeProvider>
      </div>
    </main>
  );
}
