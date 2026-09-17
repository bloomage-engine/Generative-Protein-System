/**
 * Proxy for the live subagent-activity endpoint.
 *
 * The transport-service serves the Project adapter's live subagent list at
 * `/api/transport/subagents` (JSON). The Subagents panel polls it while open.
 * A failed upstream degrades to an EMPTY list so the panel shows its neutral
 * empty state rather than an error.
 */
import { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const { search } = new URL(request.url);
  const response = await proxyToService(request, {
    path: `/api/transport/subagents${search}`,
    headers: { accept: "application/json" },
  });

  if (response.status < 200 || response.status >= 300) {
    return NextResponse.json({ subagents: [] });
  }
  return response;
}
