import "dotenv/config";

/**
 * Minimal example server for @science-studio/transport-dsh.
 *
 * Wires the real dsh adapter (which spawns `dsh --profile sdk` as a local
 * harness subprocess; env comes from `.env`, but launch-only `DSH_*` keys
 * must be EXPORTED in the shell — the dsh CLI boot layer rejects any `.env`
 * file that sets one, and this folder's `.env` is exactly what the child
 * reads, since it runs with this folder as its cwd) into the shared
 * @science-studio/transport-service. The service owns the entire
 * assistant-transport wire (reconcile-first snapshots, `set`/`append-text`
 * ops, `[DONE]` termination, the standing watch channel) — this example adds
 * no protocol code of its own, only the adapter registration.
 *
 * Endpoints (implemented by the service):
 *   POST /api/transport        command-in / SSE state-out (runs + history probes)
 *   GET  /api/transport/watch  standing watch (baseline snapshots; dsh sessions
 *                              have a single writer, so nothing settles remotely)
 */
import { DshRuntimeAdapter } from "@science-studio/transport-dsh";
import { createTransportService } from "@science-studio/transport-service";

const adapter = new DshRuntimeAdapter();
const app = await createTransportService({ adapters: [adapter] });

const port = Number(process.env.PORT ?? 3300);
await app.listen({ port, host: "127.0.0.1" });
console.log(
  `[transport-dsh-example] assistant-transport at http://localhost:${port}/api/transport`,
);
console.log(
  `[transport-dsh-example] harness: dsh --profile ${process.env.DSH_PROFILE ?? "sdk"} · model ${process.env.DSH_MODEL ?? "deepseek-v4-flash"} · session ${process.env.DSH_DEFAULT_SESSION ?? "default"}`,
);
