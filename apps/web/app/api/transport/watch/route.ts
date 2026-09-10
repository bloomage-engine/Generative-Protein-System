/**
 * Streaming proxy for the standing watch endpoint (NDJSON, long-lived).
 *
 * The transport-service pushes the session's canonical snapshot here whenever a
 * remote assistant reply settles, so an open browser can adopt it via
 * `importExternalState`. Same streaming-passthrough pattern as
 * `../route.ts` (a Next.js rewrite buffers the upstream body and would destroy
 * the long-lived frame stream) — pipe the body straight through.
 */
import { NextResponse } from "next/server";

const TRANSPORT_SERVICE_URL =
  process.env.TRANSPORT_SERVICE_URL ?? "http://localhost:3001";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forward the caller's `Authorization: Bearer <token>` upstream. A single-user
 * install sends none (there is no login); the hosted enterprise principal
 * resolver authenticates the bearer, so the proxy must not swallow it.
 */
function forwardedAuth(request: Request): Record<string, string> {
  const auth = request.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const threadId = params.get("threadId");
  const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";

  const upstream = await fetch(`${TRANSPORT_SERVICE_URL}/api/transport/watch${qs}`, {
    headers: { accept: "application/x-ndjson", ...forwardedAuth(request) },
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: `watch service error: ${upstream.status}${text ? ` ${text}` : ""}` },
      { status: upstream.status || 502 },
    );
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
