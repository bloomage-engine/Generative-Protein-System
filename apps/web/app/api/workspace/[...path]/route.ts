/**
 * Streaming proxy for the workspace file service.
 *
 * Same relay and the same reason as `app/api/transport/route.ts`: pipe the
 * upstream body through rather than using a `next.config` rewrite, which would
 * buffer it (fatal for a file stream). The catch-all forwards
 * `/api/workspace/<entries|stat|file>` to the transport-service, preserving
 * status and the headers a browser needs — including `content-disposition`,
 * which is what makes a download a download.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const { search } = new URL(request.url);
  return proxyToService(request, {
    path: `/api/workspace/${path.map(encodeURIComponent).join("/")}${search}`,
    headers: { accept: request.headers.get("accept") ?? "*/*" },
  });
}
