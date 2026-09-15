/**
 * Streaming proxy for the workspace file service.
 *
 * Same shape and the same reason as `app/api/transport/route.ts`: pipe the
 * upstream body through rather than using a `next.config` rewrite, which would
 * buffer it (fatal for the file stream). The catch-all forwards
 * `/api/workspace/<entries|stat|file>` to the transport-service, preserving
 * status and the headers a browser needs.
 *
 * Browsing/stat answers are small JSON, but `file` is a byte stream that can
 * outlive any `fetch` body deadline (a large inline file on a slow link), so the
 * hop runs on `lib/stream-proxy.ts` — the same reason the watch does.
 */
import { NextResponse } from "next/server";
import { requestStream } from "@/lib/stream-proxy";

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

/**
 * Forward the caller's `Authorization: Bearer <token>` upstream. A single-user
 * install sends none (there is no login); the hosted enterprise principal
 * resolver authenticates the bearer, so the proxy must not swallow it.
 */
function forwardedAuth(request: Request): Record<string, string> {
  const auth = request.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const search = new URL(request.url).search;
  const upstream = await requestStream(
    `${TRANSPORT_SERVICE_URL}/api/workspace/${path.map(encodeURIComponent).join("/")}${search}`,
    {
      headers: {
        accept: request.headers.get("accept") ?? "*/*",
        ...forwardedAuth(request),
      },
      forward: FORWARDED_HEADERS,
    },
  );

  // An error answer (404/400/413/503 …) is a small JSON body: pass it through
  // with the upstream status, exactly like the previous non-streaming path.
  if (!upstream.body) {
    return new NextResponse(upstream.errorText, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers: upstream.headers });
}
