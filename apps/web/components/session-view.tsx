"use client";

import { memo, useState, type FC } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { FolderIcon } from "lucide-react";
import {
  TransportApiProvider,
  WorkspaceApiProvider,
  WorkspaceOpenProvider,
  useTransport,
  useTransportApi,
  useWorkspaceAvailability,
} from "@science-studio/transport-client";

/**
 * One Project's Session: the conversation over the assistant-ui transport
 * runtime, plus that Project's workspace panel.
 *
 * `projectId`/`sessionId` come from the route and are what scope every request
 * (probe, sends, watch) and the file surface — see `useTransport` and
 * `WorkspaceApiProvider`.
 */
export const SessionView: FC<{ projectId: string; sessionId: string }> = ({
  projectId,
  sessionId,
}) => {
  const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
  const workspaceApi = process.env.NEXT_PUBLIC_WORKSPACE_URL ?? "/api/workspace";

  return (
    <TransportApiProvider api={api}>
      <WorkspaceApiProvider api={workspaceApi} project={projectId}>
        <Session projectId={projectId} sessionId={sessionId} />
      </WorkspaceApiProvider>
    </TransportApiProvider>
  );
};

/**
 * Owns the session runtime, and nothing else — deliberately state-free and
 * `memo`ized.
 *
 * `useTransport` must NOT be called by a component that re-renders: assistant-ui
 * constructs a fresh internal thread-list adapter on every invocation of
 * `useAssistantTransportRuntime`, and on a re-render the library reads the new
 * adapter identity as an adapter swap — it tears the active thread runtime down
 * and starts an empty one, wiping the transcript. The mount-time history probe
 * does not re-run, so the conversation stays blank until a page reload. Keeping
 * this component inert (route params only, no state; the API comes from context)
 * means the workspace UI re-rendering below it never reaches the hook.
 */
const Session = memo(function Session({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const api = useTransportApi();
  const runtime = useTransport({ api, projectId, threadId: sessionId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkspaceShell projectId={projectId} />
    </AssistantRuntimeProvider>
  );
});

/**
 * The page chrome and all of its interactive state: the Project's workspace
 * browser (`WorkspacePanel`) served by the same service.
 * `WorkspaceOpenProvider` is the seam between chat and panel — a workspace file
 * link in an agent reply (or in markdown) hands a `FileRef` to this page, which
 * reveals the panel and opens the file, with no navigation.
 *
 * State lives here, below the runtime-owning `Session`, so toggling the panel
 * or selecting a file never re-renders the transport hook (see `Session`).
 *
 * Workspace access is opt-in server-side, so the Files toggle probes the
 * service once (`useWorkspaceAvailability`) and disables itself with a tooltip
 * when no workspace is configured, instead of opening a panel that only shows a
 * 503.
 */
const WorkspaceShell: FC<{ projectId: string }> = ({ projectId }) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <WorkspaceOpenProvider
      onOpen={(ref) => {
        setSelectedFile(ref.workspacePath);
        setPanelOpen(true);
      }}
    >
      <main className="flex h-svh flex-col">
        <header className="border-border/70 flex items-baseline gap-3 border-b px-5 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Science Studio</h1>
          <p className="text-muted-foreground text-sm">
            Research-agent platform for computational life-science R&amp;D — a
            session with the agent over assistant-ui&apos;s assistant-transport
            protocol.
          </p>
          <FilesToggle open={panelOpen} onToggle={() => setPanelOpen((open) => !open)} />
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <Thread />
          </div>
          {panelOpen && (
            <WorkspacePanel
              project={projectId}
              selected={selectedFile}
              onSelect={setSelectedFile}
              onClose={() => setPanelOpen(false)}
            />
          )}
        </div>
      </main>
    </WorkspaceOpenProvider>
  );
};

/**
 * The Files toggle. When this deployment exposes no workspace (the probe answers
 * 503) it disables itself and explains why via its tooltip; otherwise it opens
 * the browser panel.
 */
const FilesToggle: FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => {
  const { available, reason } = useWorkspaceAvailability();
  const disabled = available === false;

  return (
    <span className="ms-auto inline-flex" title={disabled ? (reason ?? undefined) : undefined}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={open}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40"
      >
        <FolderIcon className="size-4" />
        Files
      </button>
    </span>
  );
};
