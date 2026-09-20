/**
 * Proxy for the live subagent-activity endpoint.
 *
 * The transport-service serves the Project adapter's live subagent list at
 * `/api/transport/subagents` (JSON). The Subagents panel polls it while open.
 * The hop relays the upstream status and body verbatim (docs/adr/0021): a
 * transient failure reaches `useSubagents`, which keeps its last good list
 * instead of blanking the panel.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport/subagents${search}`,
    headers: { accept: "application/json" },
  });
}
