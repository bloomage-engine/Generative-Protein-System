/**
 * Streaming proxy for the workspace file service.
 *
 * Same relay and the same reason as `app/api/transport/route.ts`: pipe the
 * upstream body through rather than using a `next.config` rewrite, which would
 * buffer it (fatal for a file stream). The catch-all forwards
 * `/api/workspace/<entries|stat|file>` to the transport-service, preserving
 * status and the headers a browser needs — including `content-disposition`,
 * which is what makes a download a download.
 *
 * The `POST` hop carries the two mutations: `upload` (raw file bytes, relayed
 * verbatim) and `delete` (bodyless). Both ride the same relay, so the policy
 * (service base, forwarded auth, verbatim status/body) has one home.
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

export async function POST(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const { search } = new URL(request.url);
  // `upload` ships the file's bytes; `delete` ships nothing. Buffering the body
  // here keeps the relay the single code path both mutations share.
  const body = new Uint8Array(await request.arrayBuffer());
  return proxyToService(request, {
    path: `/api/workspace/${path.map(encodeURIComponent).join("/")}${search}`,
    method: "POST",
    body,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/octet-stream",
      accept: request.headers.get("accept") ?? "application/json",
    },
  });
}
