/**
 * Proxy for the skills surface (docs/adr/0020).
 *
 * The transport-service serves the Project adapter's skills at `/api/skills`
 * (GET) and `/api/skills/{install,remove}` (POST). This catch-all relays both
 * through the shared `service-proxy` policy: the caller's auth is forwarded and
 * the upstream status/body are relayed verbatim, so the service's own 400/403/
 * 404/409/501/503 diagnosis reaches the dialog.
 */
import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(
  request: Request,
  path: string[] | undefined,
  method: "GET" | "POST",
): Promise<NextResponse> {
  const suffix = path && path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { search } = new URL(request.url);
  const body = method === "GET" ? "" : await request.text();
  return proxyToService(request, {
    path: `/api/skills${suffix}${search}`,
    method,
    headers: {
      accept: "application/json",
      ...(body !== "" ? { "content-type": "application/json" } : {}),
    },
    ...(body !== "" ? { body } : {}),
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "GET");
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "POST");
}
