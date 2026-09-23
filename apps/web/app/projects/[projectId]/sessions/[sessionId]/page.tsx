import { StudioPage } from "@/components/studio/page";

/**
 * The LEGACY conversation deep-link: `/projects/<projectId>/sessions/<sessionId>`.
 *
 * It predates the Worktree scope, so it names no worktree and stays as a
 * compatibility pass-through: `StudioPage` resolves one (`routeWorktreeId=null`
 * falls back to the Project's remembered worktree, else `main`) and then mirrors
 * the full three-part URL with `history.replaceState`. A reload of the new
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
    <StudioPage routeProjectId={projectId} routeWorktreeId={null} routeSessionId={sessionId} />
  );
}
