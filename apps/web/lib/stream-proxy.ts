/**
 * The pass-through used by every STREAMING `/api` proxy.
 *
 * `fetch()` cannot serve these hops: its undici body deadline is 300 s of
 * silence (`UND_ERR_BODY_TIMEOUT`), and a stream that is idle BY DESIGN — the
 * standing watch only pushes when a remote run settles — therefore died at the
 * 5-minute mark with "failed to pipe response" and a 500 for the browser. A
 * relay must impose NO idle deadline: both peers decide when a stream is over.
 *
 * `node:http`/`node:https` have no idle timeout by default, so the upstream
 * request is issued there and its body is handed over as a web `ReadableStream`
 * — the shape `NextResponse` accepts. Cancelling that stream (a browser tab
 * that goes away, a `useTransport` re-render that abandons the watch) destroys
 * the upstream socket, so nothing is left streaming to nobody.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** One upstream answer to a streaming request. */
export interface StreamUpstream {
  /** The upstream status, forwarded verbatim. */
  status: number;
  /** The named response headers the upstream actually sent. */
  headers: Record<string, string>;
  /** The live body of a 2xx answer. `null` for any other status (see `errorText`). */
  body: ReadableStream<Uint8Array> | null;
  /** The buffered body of a non-2xx answer (always small: an error payload). */
  errorText: string;
}

export interface StreamUpstreamOptions {
  method?: string;
  headers?: Record<string, string>;
  /** The request body to send; these payloads are small and already read. */
  body?: string;
  /** Response headers to forward, by name (only those the upstream sent). */
  forward?: readonly string[];
}

/** Issue `target` and resolve with its answer, streaming a 2xx body. */
export async function requestStream(
  target: string,
  options: StreamUpstreamOptions = {},
): Promise<StreamUpstream> {
  const url = new URL(target);
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }

  return await new Promise<StreamUpstream>((resolve, reject) => {
    const onResponse = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 502;
      const forwarded: Record<string, string> = {};
      for (const name of options.forward ?? []) {
        const value = res.headers[name.toLowerCase()];
        if (typeof value === "string") forwarded[name] = value;
      }
      if (status >= 200 && status < 300) {
        resolve({
          status,
          headers: forwarded,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
          errorText: "",
        });
        return;
      }
      // An error answer is small and is re-shaped by the caller.
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status,
          headers: forwarded,
          body: null,
          errorText: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    };

    const upstream =
      url.protocol === "https:"
        ? httpsRequest(url, { method, headers }, onResponse)
        : httpRequest(url, { method, headers }, onResponse);
    upstream.on("error", reject);
    upstream.end(options.body);
  });
}
