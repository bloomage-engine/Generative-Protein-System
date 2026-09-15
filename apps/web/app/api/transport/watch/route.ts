/**
 * Streaming proxy for the standing watch endpoint (NDJSON, long-lived).
 *
 * The transport-service pushes the session's canonical snapshot here whenever a
 * remote assistant reply settles, so an open browser can adopt it via
 * `importExternalState`. Same streaming-passthrough pattern as `../route.ts` (a
 * Next.js rewrite buffers the upstream body and would destroy the long-lived
 * frame stream), and the same rule about idle time: the watch is SILENT until a
 * run settles, so the hop carries no body deadline at all — an undici default
 * (300 s) used to kill every idle watch with a 500 (`lib/stream-proxy.ts`).
 */
import { NextResponse } from "next/server";
import { requestStream } from "@/lib/stream-proxy";

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
  const query = new URLSearchParams();
  // `projectId` is the scope `useTransport` appends; keep `project` too so an
  // older caller is not silently unscoped.
  for (const key of ["projectId", "project", "threadId"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const qs = query.toString() ? `?${query}` : "";

  const upstream = await requestStream(`${TRANSPORT_SERVICE_URL}/api/transport/watch${qs}`, {
    headers: { accept: "application/x-ndjson", ...forwardedAuth(request) },
    forward: ["content-type"],
  });

  if (!upstream.body) {
    return NextResponse.json(
      {
        error: `watch service error: ${upstream.status}${upstream.errorText ? ` ${upstream.errorText}` : ""}`,
      },
      { status: upstream.status || 502 },
    );
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers["content-type"] ?? "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
