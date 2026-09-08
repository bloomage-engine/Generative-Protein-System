/**
 * Proxy for the runtime command catalog endpoint.
 *
 * The transport-service serves the runtime adapter's command catalog at
 * `/api/transport/commands` (JSON, docs/adr/0003). A failed upstream is
 * reported as an empty catalog so the composer falls back to plain chat
 * instead of failing the page.
 */
import { NextResponse } from "next/server";

const TRANSPORT_SERVICE_URL =
  process.env.TRANSPORT_SERVICE_URL ?? "http://localhost:3001";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const upstream = await fetch(
    `${TRANSPORT_SERVICE_URL}/api/transport/commands`,
    { headers: { accept: "application/json" } },
  );

  if (!upstream.ok) {
    return NextResponse.json({ commands: [] }, { status: 200 });
  }

  const body: unknown = await upstream.json();
  return NextResponse.json(body);
}
