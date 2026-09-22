/**
 * Proxy for the run-control abort hop.
 *
 * The stop button reaches the service through this route so the Project's own
 * adapter can cancel the in-flight turn (openclaw `chat.abort`, dsh
 * `agent.cancel` through the child bridge). Same relay as every other hop —
 * `proxyToService` forwards the caller's auth and relays the status verbatim.
 *
 * The Project/Session scope rides in the query, exactly as it does for the
 * transport and watch hops, so the service resolves the same Project's adapter.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport/abort${search}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: (await request.text()) || "{}",
  });
}
