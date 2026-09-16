/**
 * The relay every `/api` proxy hop runs on.
 *
 * The browser must never talk to the transport-service directly, and every hop
 * shares one policy: the service base URL, the caller's `Authorization` header
 * forwarded upstream, and the upstream's status and body relayed verbatim.
 * Written out per route that was five copies of the same ten lines with the same
 * four-line comment — adding a forwarded header meant editing five files, and a
 * hop that was missing simply did not exist.
 *
 * The relay runs on `lib/stream-proxy.ts` (`node:http`), NOT `fetch`: undici
 * aborts a response body after 300 s of silence, and several of these streams are
 * idle BY DESIGN (the standing watch only pushes when a remote run settles), so
 * every idle watch died at the five-minute mark. A short JSON hop pays nothing
 * for the same treatment — one relay, no "which one does this route use?".
 *
 * `runtime`/`dynamic` stay literal in each route file: Next requires route
 * segment config to be statically analyzable, so it cannot be re-exported from
 * here.
 */
import { NextResponse } from "next/server";
import { requestStream } from "@/lib/stream-proxy";

/** The transport-service origin — one place, so a deployment moves it once. */
export const SERVICE_URL = process.env.TRANSPORT_SERVICE_URL ?? "http://localhost:3001";

export interface ServiceHop {
  /** The upstream path AND its query, e.g. `/api/transport/watch?threadId=s1`. */
  path: string;
  method?: "GET" | "POST" | "PUT";
  /** The request body: text for the small JSON hops, or raw bytes for an upload. */
  body?: string | Uint8Array;
  /** Request headers for the upstream call (`accept`, `content-type`). */
  headers?: Record<string, string>;
  /** Response headers to relay, by name. Defaults to {@link DEFAULT_FORWARD}. */
  forward?: readonly string[];
}

/** What a proxied answer needs: its type, length, name and freshness. */
const DEFAULT_FORWARD = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
] as const;

/** The upstream URL for a path. */
export function serviceUrl(path: string): string {
  return `${SERVICE_URL}${path}`;
}

/**
 * Forward the caller's `Authorization: Bearer <token>` upstream. A single-user
 * install sends none (there is no login); the hosted enterprise principal
 * resolver authenticates the bearer, so the proxy must not swallow it.
 */
export function forwardedAuth(request: Request): Record<string, string> {
  const auth = request.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

/**
 * Relay one hop. The upstream's status and body pass through VERBATIM — a proxy
 * that re-shapes an error only hides the service's own diagnosis, and no client
 * here reads those bodies (a failed run is a failure by status).
 */
export async function proxyToService(
  request: Request,
  hop: ServiceHop,
): Promise<NextResponse> {
  const upstream = await requestStream(serviceUrl(hop.path), {
    method: hop.method ?? "GET",
    headers: { ...forwardedAuth(request), ...hop.headers },
    forward: hop.forward ?? DEFAULT_FORWARD,
    ...(hop.body !== undefined ? { body: hop.body } : {}),
  });

  const headers: Record<string, string> = { ...upstream.headers };
  // Nothing behind this hop is cacheable — it serves live session state — so an
  // answer that does not say otherwise gets `no-store`.
  if (headers["cache-control"] === undefined) headers["cache-control"] = "no-store";

  return new NextResponse(upstream.body ?? upstream.errorText, {
    status: upstream.status,
    headers,
  });
}
