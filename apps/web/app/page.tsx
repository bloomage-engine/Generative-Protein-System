"use client";

import { useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { FolderIcon } from "lucide-react";
import {
  TransportApiProvider,
  WorkspaceApiProvider,
  WorkspaceOpenProvider,
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
 *
 * Beside it sits the session's workspace browser (`WorkspacePanel`), served by
 * the same service. `WorkspaceOpenProvider` is the seam between them: a
 * workspace file link in an agent reply (or in markdown) hands a `FileRef` to
 * this page, which reveals the panel and opens the file — no navigation.
 */
export default function Home() {
  const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
  const workspaceApi = process.env.NEXT_PUBLIC_WORKSPACE_URL ?? "/api/workspace";
  const runtime = useTransport({ api });

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <main className="flex h-svh flex-col">
      <header className="border-border/70 flex items-baseline gap-3 border-b px-5 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Science Studio</h1>
        <p className="text-muted-foreground text-sm">
          Research-agent platform for computational life-science R&amp;D — a
          session with the agent over assistant-ui&apos;s assistant-transport
          protocol.
        </p>
        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          className="text-muted-foreground hover:text-foreground ms-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm"
          aria-pressed={panelOpen}
        >
          <FolderIcon className="size-4" />
          Files
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <TransportApiProvider api={api}>
            <WorkspaceApiProvider api={workspaceApi}>
              <WorkspaceOpenProvider
                onOpen={(ref) => {
                  setSelectedFile(ref.workspacePath);
                  setPanelOpen(true);
                }}
              >
                <AssistantRuntimeProvider runtime={runtime}>
                  <Thread />
                </AssistantRuntimeProvider>
              </WorkspaceOpenProvider>
            </WorkspaceApiProvider>
          </TransportApiProvider>
        </div>
        {panelOpen && (
          <WorkspacePanel
            selected={selectedFile}
            onSelect={setSelectedFile}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
    </main>
  );
}
