import { StudioPage } from "@/components/studio/page";

/**
 * The conversation deep-link: `/projects/<projectId>/sessions/<sessionId>`.
 *
 * The URL scopes the session (refresh/share-safe): route params seed the
 * store, then the same `StudioPage`/`SessionView` workbench renders — identical
 * to the SPA home but with the route's Project/Session pre-selected.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <StudioPage routeProjectId={projectId} routeSessionId={sessionId} />;
}
