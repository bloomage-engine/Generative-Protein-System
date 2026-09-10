import "dotenv/config";

/**
 * Minimal example server for @science-studio/transport-openclaw.
 *
 * Wires the real OpenClaw adapter (gateway URL/token from `.env`) into the
 * shared @science-studio/transport-service. The service owns the entire
 * assistant-transport wire (reconcile-first snapshots, `set`/`append-text`
 * ops, `[DONE]` termination, the standing watch channel) — this example adds
 * no protocol code of its own, only the adapter registration.
 *
 * Endpoints (implemented by the service):
 *   POST /api/transport        command-in / SSE state-out (runs + history probes)
 *   GET  /api/transport/commands  runtime command catalog for the slash menu
 *   GET  /api/transport/watch  standing watch (remote replies from the gateway)
 */
import { OpenClawRuntimeAdapter } from "@science-studio/transport-openclaw";
import { createTransportService } from "@science-studio/transport-service";

const adapter = new OpenClawRuntimeAdapter();
const app = await createTransportService({ adapters: [adapter] });

const port = Number(process.env.PORT ?? 3200);
await app.listen({ port, host: "127.0.0.1" });
console.log(
  `[transport-openclaw-example] assistant-transport at http://localhost:${port}/api/transport`,
);
console.log(
  `[transport-openclaw-example] gateway session: ${process.env.OPENCLAW_DEFAULT_SESSION ?? "agent:main:main"}`,
);
