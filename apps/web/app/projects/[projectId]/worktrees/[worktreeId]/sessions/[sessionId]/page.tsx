import { StudioPage } from "@/components/studio/page";

/**
 * The conversation deep-link under a Worktree:
 * `/projects/<projectId>/worktrees/<worktreeId>/sessions/<sessionId>`.
 *
 * This is the shape `setScope` mirrors into the URL (docs/adr/0009, 0025), so a
 * reload lands here. The URL scopes all three parts (refresh/share-safe): the
 * route params seed the store, then the same `StudioPage`/`SessionView`
 * workbench renders — identical to the SPA home but with the route's
 * Project/Worktree/Session pre-selected. An id the record does not list is
 * discarded by resolution, never opened.
 */
export default async function WorktreeSessionPage({
  params,
}: {
  params: Promise<{ projectId: string; worktreeId: string; sessionId: string }>;
}) {
  const { projectId, worktreeId, sessionId } = await params;
  return (
    <StudioPage
      routeProjectId={projectId}
      routeWorktreeId={worktreeId}
      routeSessionId={sessionId}
    />
  );
}
