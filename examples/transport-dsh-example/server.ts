import "dotenv/config";

/**
 * Minimal example server for @gps/transport-dsh.
 *
 * Wires the real dsh adapter (which spawns `dsh --profile sdk` as a local
 * harness subprocess; the model route comes from `.env` as
 * `HARNESS_PROVIDER`/`HARNESS_MODEL`, promoted below — a launch-only `DSH_*`
 * key cannot be spelled in `.env`, because this folder's `.env` is exactly
 * what the child reads, since it runs with this folder as its cwd, and the dsh
 * CLI boot layer refuses such a file) into the shared
 * @gps/transport-service. The service owns the entire
 * assistant-transport wire (reconcile-first snapshots, `set`/`append-text`
 * ops, `[DONE]` termination, the standing watch channel) — this example adds
 * no protocol code of its own, only the adapter registration.
 *
 * Endpoints (implemented by the service):
 *   POST /api/transport        command-in / SSE state-out (runs + history probes)
 *   GET  /api/transport/watch  standing watch (baseline snapshots; dsh sessions
 *                              have a single writer, so nothing settles remotely)
 */
import { DshRuntimeAdapter } from "@gps/transport-dsh";
import { createTransportService } from "@gps/transport-service";

/**
 * `.env` may not spell the adapter's launch knobs directly: the harness child
 * boots with this folder as its cwd, discovers THIS file, and hard-refuses any
 * bootstrap-only name (`DSH_*`/`XDG_*`/`DYLD_*`/…). The model route is
 * therefore `HARNESS_PROVIDER`/`HARNESS_MODEL` here and is promoted before the
 * adapter reads it; an exported `DSH_*` still wins.
 */
const promote = (from: string | undefined, to: string): void => {
  if (from !== undefined && process.env[to] === undefined) process.env[to] = from;
};
promote(process.env.HARNESS_PROVIDER, "DSH_PROVIDER");
promote(process.env.HARNESS_MODEL, "DSH_MODEL");

const adapter = new DshRuntimeAdapter();
const app = await createTransportService({ adapters: [adapter] });

const port = Number(process.env.PORT ?? 3300);
await app.listen({ port, host: "127.0.0.1" });
console.log(
  `[transport-dsh-example] assistant-transport at http://localhost:${port}/api/transport`,
);
console.log(
  `[transport-dsh-example] harness: dsh --profile ${process.env.DSH_PROFILE ?? "sdk"} · provider ${process.env.DSH_PROVIDER ?? "deepseek-official"} · model ${process.env.DSH_MODEL ?? "deepseek-v4-flash"} · session ${process.env.DSH_DEFAULT_SESSION ?? "default"}`,
);
