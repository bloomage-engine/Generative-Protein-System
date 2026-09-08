"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { TransportApiProvider, useTransport } from "@science-studio/transport-client";
import { useTransportWatch } from "@/hooks/use-transport-watch";

/**
 * Conversation page.
 *
 * The chat UI is the Thread component registered from the assistant-ui
 * registry (https://www.assistant-ui.com/docs/installation) —
 * `components/assistant-ui/elements/thread.aui`. The runtime wiring is
 * `useTransport` from `@science-studio/transport-client` (assistant-ui
 * transport runtime + mount-time history probe) over the transport-service.
 */
export default function Home() {
  const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
  // Also loads the session's history on mount (command-less probe →
  // importExternalState), converging a fresh page or reload to the full
  // gateway history via the backend's reconcile.
  const runtime = useTransport({ api });
  // Standing watch: adopt remote assistant replies pushed by the transport-
  // service (openclaw TUI/UI) without a page refresh. The one-shot probe in
  // useTransport still seeds the initial snapshot.
  useTransportWatch(api, runtime);

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
        <TransportApiProvider api={api}>
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread />
          </AssistantRuntimeProvider>
        </TransportApiProvider>
      </div>
    </main>
  );
}
