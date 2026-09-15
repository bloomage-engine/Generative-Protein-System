/**
 * Proxy for the runtime command catalog endpoint.
 *
 * The transport-service serves the runtime adapter's command catalog at
 * `/api/transport/commands` (JSON, docs/adr/0003), and the composer's slash menu
 * fetches it once on mount. This is the ONE hop with a policy of its own: a
 * failed upstream is reported as an EMPTY catalog, so the composer falls back to
 * plain chat instead of failing the page.
 */
import { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const response = await proxyToService(request, {
    path: "/api/transport/commands",
    headers: { accept: "application/json" },
  });

  if (response.status < 200 || response.status >= 300) {
    return NextResponse.json({ commands: [] });
  }
  return response;
}
