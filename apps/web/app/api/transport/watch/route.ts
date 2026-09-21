/**
 * Streaming proxy for the standing watch endpoint (NDJSON, long-lived).
 *
 * The transport-service pushes the session's canonical snapshot here whenever a
 * remote assistant reply settles, so an open browser can adopt it via
 * `importExternalState`. Same streaming relay as `../route.ts` (a Next.js
 * rewrite buffers the upstream body and would destroy the frame stream).
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  // `projectId` is the scope `useTransport` appends; keep `project` too so an
  // older caller is not silently unscoped. Only these three reach the upstream —
  // the watch is the one hop whose query is whitelisted rather than relayed.
  for (const key of ["projectId", "project", "threadId"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const qs = query.toString() ? `?${query}` : "";

  return proxyToService(request, {
    path: `/api/transport/watch${qs}`,
    headers: { accept: "application/x-ndjson" },
    // The watch streams NOTHING until a remote run settles — an abandoned one
    // is dead weight that never resolves on its own, so it is the one hop that
    // dies with the client. Chrome pools its socket on fetch abort instead of
    // resetting it, so the relay sees no socket-level signal and must key off
    // the request's own (leaking one upstream per abandoned watch otherwise).
    signal: request.signal,
  });
}
