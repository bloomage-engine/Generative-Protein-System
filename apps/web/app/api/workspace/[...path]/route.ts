/**
 * Streaming proxy for the workspace file service.
 *
 * Same shape and the same reason as `app/api/transport/route.ts`: pipe the
 * upstream body through rather than using a `next.config` rewrite, which would
 * buffer it (fatal for the file stream). The catch-all forwards
 * `/api/workspace/<entries|stat|file>` to the transport-service, preserving
 * status and the headers a browser needs.
 */
import { NextResponse } from "next/server";

const TRANSPORT_SERVICE_URL =
  process.env.TRANSPORT_SERVICE_URL ?? "http://localhost:3001";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
] as const;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const search = new URL(request.url).search;
  const upstream = await fetch(
    `${TRANSPORT_SERVICE_URL}/api/workspace/${path.map(encodeURIComponent).join("/")}${search}`,
    { headers: { accept: request.headers.get("accept") ?? "*/*" } },
  );

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
