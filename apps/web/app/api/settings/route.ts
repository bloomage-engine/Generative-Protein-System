/**
 * Proxy for the deployment settings routes (`/api/settings`).
 *
 * Same-origin for the browser, caller's `Authorization` forwarded upstream. A
 * plain JSON in / JSON out hop with no stream to preserve; it relays through the
 * one proxy policy.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  return proxyToService(request, { path: "/api/settings", method: "GET" });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body = await request.text();
  return proxyToService(request, {
    path: "/api/settings",
    method: "PUT",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
  });
}
