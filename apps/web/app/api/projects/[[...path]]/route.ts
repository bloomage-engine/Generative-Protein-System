/**
 * Proxy for the record routes (`/api/projects*`).
 *
 * The browser stays same-origin and the caller's `Authorization: Bearer <token>`
 * is forwarded upstream (a single-user install sends none; the hosted enterprise
 * principal resolver authenticates it). There is no stream to preserve here —
 * these routes are plain JSON in / JSON out — but they relay through the same
 * hop as everything else, so there is one proxy policy to know.
 *
 * The optional catch-all matches BOTH the collection (`/api/projects`) and its
 * sub-routes (`/api/projects/<id>/sessions`, `/runs`, `/archive`).
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
  const body = method === "POST" ? await request.text() : "";

  return proxyToService(request, {
    path: `/api/projects${suffix}${search}`,
    method,
    headers: {
      accept: "application/json",
      // Only declare a JSON body when there is one: Fastify rejects an empty
      // body that claims `application/json` (e.g. POST /archive).
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
