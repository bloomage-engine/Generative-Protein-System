/**
 * Proxy for the runtime command catalog endpoint.
 *
 * The transport-service serves the runtime adapter's command catalog at
 * `/api/transport/commands` (JSON, docs/adr/0003), and the composer's slash menu
 * fetches it once on mount. The hop relays the upstream status and body
 * verbatim (docs/adr/0021): `useRuntimeCommands` owns the degrade to an empty
 * catalog, so the composer falls back to plain chat instead of failing the page.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  // The catalog belongs to the Project's OWN adapter (one per Project,
  // docs/adr/0008), so the client's Project claim must reach the service — the
  // same reason the transport route relays its query.
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/transport/commands${search}`,
    headers: { accept: "application/json" },
  });
}
