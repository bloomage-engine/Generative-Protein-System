/**
 * Proxy for the record routes (`/api/projects*`).
 *
 * Same shape and reason as the workspace proxy: the browser stays same-origin and
 * the caller's `Authorization: Bearer <token>` is forwarded upstream (a
 * single-user install sends none; the hosted enterprise principal resolver
 * authenticates it, so the proxy must not swallow it).
 *
 * Unlike transport there is no stream to preserve — these routes are plain JSON
 * in / JSON out — so the body and status are passed through as text. The
 * optional catch-all matches BOTH the collection (`/api/projects`) and its
 * sub-routes (`/api/projects/<id>/sessions`, `/runs`, `/archive`).
 */
import { NextResponse } from "next/server";

const TRANSPORT_SERVICE_URL =
  process.env.TRANSPORT_SERVICE_URL ?? "http://localhost:3001";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function forwardedAuth(request: Request): Record<string, string> {
  const auth = request.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

async function forward(
  request: Request,
  path: string[] | undefined,
  method: "GET" | "POST",
): Promise<NextResponse> {
  const suffix = path && path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const search = new URL(request.url).search;
  const body = method === "POST" ? await request.text() : "";

  const upstream = await fetch(`${TRANSPORT_SERVICE_URL}/api/projects${suffix}${search}`, {
    method,
    headers: {
      accept: "application/json",
      // Only declare a JSON body when there is one: Fastify rejects an empty
      // body that claims `application/json` (e.g. POST /archive).
      ...(body !== "" ? { "content-type": "application/json" } : {}),
      ...forwardedAuth(request),
    },
    ...(body !== "" ? { body } : {}),
  });

  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
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
