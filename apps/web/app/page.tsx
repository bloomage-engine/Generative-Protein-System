"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import {
  TransportApiProvider,
  useTransport,
} from "@science-studio/transport-client";

/**
 * Conversation page.
 *
 * The chat UI is the Thread component registered from the assistant-ui
 * registry (https://www.assistant-ui.com/docs/installation) —
 * `components/assistant-ui/elements/thread.aui`. The runtime wiring is the
 * single session hook `useTransport` from `@science-studio/transport-client`:
 * assistant-ui transport runtime over the transport-service, with the
 * session's history loaded on mount (command-less probe → importExternalState)
 * and the standing watch adopted (remote turns and native command replies,
 * which never stream over a run channel).
 */
export default function Home() {
  const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
  const runtime = useTransport({ api });

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
