/**
 * Proxy for the subagent child-session record endpoint.
 *
 * The transport-service serves ONE delegated session's readable record at
 * `GET /api/transport/subagents/:childId/transcript` (JSON). The proxy
 * relays verbatim (same one policy as every other hop) — a 404 (absent,
 * unreadable, or no-surface record) is the expected shape, which the
 * SubagentRenderer renders as its friendly "not available" state.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ childId: string }> },
): Promise<NextResponse> {
  const { childId } = await ctx.params;
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport/subagents/${encodeURIComponent(childId)}/transcript${search}`,
    headers: { accept: "application/json" },
  });
}
