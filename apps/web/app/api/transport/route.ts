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

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.text();

  const upstream = await fetch(
    `${TRANSPORT_SERVICE_URL}/api/transport`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
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
