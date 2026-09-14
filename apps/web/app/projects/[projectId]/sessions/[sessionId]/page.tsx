import { SessionView } from "@/components/session-view";

/**
 * The conversation route: `/projects/<projectId>/sessions/<sessionId>`.
 *
 * The URL is the session's identity source (refresh- and share-safe): the route
 * params scope every transport request and the workspace panel. A server
 * component so the params unwrap server-side; the interactive tree is the
 * client `SessionView`.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionView projectId={projectId} sessionId={sessionId} />;
}
