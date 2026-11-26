import type { NextResponse } from "next/server";
import { proxyToService } from "@/lib/service-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function forward(
  request: Request,
  path: string[] | undefined,
  method: Method,
): Promise<NextResponse> {
  const suffix = path && path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { search } = new URL(request.url);
  const body = method === "GET" || method === "DELETE" ? "" : await request.text();
  return proxyToService(request, {
    path: `/api/mcp${suffix}${search}`,
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

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "PUT");
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(request, path, "DELETE");
}
