import { StudioPage } from "@/components/studio/page";
import { DEFAULT_WORKTREE_ID } from "@/lib/scope-memory";

/**
 * The LEGACY conversation deep-link: `/projects/<projectId>/sessions/<sessionId>`.
 *
 * It predates the Worktree scope, so a Session it names was created under
 * `main`; the route pins `routeWorktreeId={DEFAULT_WORKTREE_ID}` accordingly. A
 * `null` worktree claim would fall through to the Project's REMEMBERED worktree
 * (e.g. `exp-a`), fail to find the `main` session there, and open that
 * worktree's newest Session instead — a silent switch to another checkout.
 * `StudioPage` then mirrors the full three-part URL with
 * `history.replaceState`. A reload of the new
 * `/projects/<projectId>/worktrees/<worktreeId>/sessions/<sessionId>` route never
 * reaches here; this is only an old bookmark or link.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return (
    <StudioPage
      routeProjectId={projectId}
      routeWorktreeId={DEFAULT_WORKTREE_ID}
      routeSessionId={sessionId}
    />
  );
}
