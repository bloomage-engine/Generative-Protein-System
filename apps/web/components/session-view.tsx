"use client";

import { memo, type FC } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  TransportApiProvider,
  WorkspaceApiProvider,
  WorkspaceOpenProvider,
  useTransport,
  useTransportApi,
} from "@science-studio/transport-client";
import { StudioShell } from "./studio/shell";
import { useStudioStore } from "@/store/studio-store";

/**
 * One Project's Session: the conversation over the assistant-transport runtime
 * inside the Studio 3-pane workbench (files / tab / panel state all in
 * `useStudioStore`). `projectId`/`sessionId` scope every request — they come
 * from the SPA store (home) or the route (deep-link).
 *
 * The scope may be EMPTY (a fresh install, or a Project with no Session yet):
 * the workbench chrome still renders and only the runtime is skipped, because
 * the left pane's Projects view is where the first Project/Session gets created
 * — a chrome-less "nothing is open" page would take away the one control that
 * can fix it.
 */
export const SessionView: FC<{ projectId: string | null; sessionId: string | null }> = ({
  projectId,
  sessionId,
}) => {
  const api = process.env.NEXT_PUBLIC_TRANSPORT_URL ?? "/api/transport";
  const workspaceApi = process.env.NEXT_PUBLIC_WORKSPACE_URL ?? "/api/workspace";

  return (
    <TransportApiProvider api={api}>
      <WorkspaceApiProvider api={workspaceApi} project={projectId}>
        {projectId && sessionId ? (
          <Session projectId={projectId} sessionId={sessionId} />
        ) : (
          <StudioShell projectId={projectId} />
        )}
      </WorkspaceApiProvider>
    </TransportApiProvider>
  );
};

/**
 * Owns the session runtime, and nothing else — deliberately state-free and
 * memoized. `useTransport` must not be called by a component that re-renders:
 * assistant-ui rebuilds its internal thread-list adapter on every invocation,
 * and a re-render reads as an adapter swap — it tears the active thread down,
 * wiping the transcript (and the mount-time probe does not re-run). The workbench
 * chrome (view/tab/panel toggles, file selects) lives in `useStudioStore` and a
 * child below, so re-rendering them never reaches the hook.
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
  const openFile = useStudioStore((s) => s.openFile);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkspaceOpenProvider onOpen={(ref) => openFile(ref.workspacePath, ref.name)}>
        <StudioShell projectId={projectId} />
      </WorkspaceOpenProvider>
    </AssistantRuntimeProvider>
  );
});
