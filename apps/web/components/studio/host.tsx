"use client";

import { SessionView } from "@/components/session-view";
import { useStudioStore } from "@/store/studio-store";

/**
 * Render the workbench for whatever Project/Session the store currently
 * scopes. Callers (the SPA home and the session deep-link) are responsible for
 * seeding the store; this component just reacts and re-keys `SessionView` on
 * every scope change, which remounts the runtime-owning `Session` and re-runs
 * the transport probe for the new scope. Chrome state (view/panels/tabs) is NOT
 * in the key, so switching the left view never re-renders the `useTransport`
 * host. An empty scope is not an error state — the shell still renders and the
 * left pane's Projects view creates the first scope.
 */
export function StudioHost() {
  const projectId = useStudioStore((s) => s.projectId);
  const worktreeId = useStudioStore((s) => s.activeWorktreeId);
  const sessionId = useStudioStore((s) => s.activeSessionId);

  return (
    <SessionView
      key={`${projectId}/${worktreeId}/${sessionId}`}
      projectId={projectId}
      worktreeId={worktreeId}
      sessionId={sessionId}
    />
  );
}
