/**
 * Streaming proxy for the assistant-transport endpoint.
 *
 * Next.js `rewrites()` buffers the whole upstream body in dev, which destroys
 * the SSE token stream — so instead of a rewrite this route pipes the
 * transport-service response body through directly (both dev and prod). The
 * transport-service already sends CORS headers and ends the stream with
 * `data: [DONE]`.
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

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.text();
  // Preserve the query: the client carries the Project/Session scope there (it
  // cannot inject fields into assistant-ui's own send body), and the service
  // reads it as a fallback.
  const search = new URL(request.url).search;

  const upstream = await fetch(
    `${TRANSPORT_SERVICE_URL}/api/transport${search}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...forwardedAuth(request),
      },
      body,
    },
  );

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `transport-service error: ${upstream.status}` },
      { status: upstream.status },
    );
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
