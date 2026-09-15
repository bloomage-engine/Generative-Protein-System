/**
 * SSE proxy for the assistant-transport endpoint.
 *
 * Next.js `rewrites()` buffers the whole upstream body in dev, which destroys
 * the SSE token stream — so instead of a rewrite this route relays the upstream
 * response straight through (both dev and prod). The transport-service already
 * sends CORS headers and ends every stream with `data: [DONE]`.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // The client carries the Project/Session scope in the query — it cannot inject
  // fields into assistant-ui's own send body — so the query must reach the
  // service.
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport${search}`,
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: await request.text(),
  });
}
