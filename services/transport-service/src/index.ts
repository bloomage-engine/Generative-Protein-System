import "dotenv/config";

/**
 * Backend assistant-transport service.
 *
 * Speaks assistant-ui's `useAssistantTransportRuntime` wire protocol to the
 * frontend (command-in / state-snapshot-out) and delegates execution to a
 * registered `RuntimeAdapter`. The frontend never changes when the runtime
 * swaps (docs/adr/0001); the runtime is selected by configuration through the
 * factory registry, so no core package statically imports a runtime.
 *
 * Deployment mode is answered ONLY in `createBackend()` (composition.ts):
 * single-user by default, or a private enterprise module when configured.
 */
import type { FastifyInstance } from "fastify";
import { createInMemoryRecordStore, type RecordStore } from "@science-studio/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
} from "@science-studio/transport";
import {
  createBackend,
  localWorkspace,
  resolveRuntimePlugins,
  toRecordStoreLike,
  type Backend,
  type CorsConfig,
} from "./composition.js";
import { createServer } from "./server.js";

export { createBackend, loadRuntimePlugins, localWorkspace, resolveRuntimePlugins, toRecordStoreLike } from "./composition.js";
export type { Backend, CorsConfig, EnterpriseModule } from "./composition.js";
export { createServer } from "./server.js";

export interface TransportServiceOptions {
  /** A ready backend (production path). */
  backend?: Backend;
  /**
   * Example/test seam: launch with these already-constructed adapters, which
   * the service initializes using each runtime's local binding. Prefer
   * `backend` or `createBackend()` in new code.
   */
  adapters?: RuntimeAdapter[];
  recordStore?: RecordStore;
  cors?: CorsConfig;
}

/**
 * Build the Fastify app. Kept as the single entry point so the examples and the
 * service tests share exactly the wiring production uses.
 */
export async function createTransportService(
  options: TransportServiceOptions = {},
): Promise<FastifyInstance> {
  const backend = options.backend ?? (await backendFromAdapters(options));
  return createServer(backend);
}

/** Compatibility path: wrap caller-supplied adapters in a local backend. */
async function backendFromAdapters(options: TransportServiceOptions): Promise<Backend> {
  const adapters = options.adapters ?? [];
  const first = adapters[0];
  if (!first) {
    throw new Error("createTransportService: pass a `backend`, or at least one adapter");
  }

  const env = process.env;
  const plugins = await resolveRuntimePlugins(env);
  // One authoritative store: the adapter persists Runs through its narrowed view
  // of it, and the service resolves Session identity from the same instance.
  const records = options.recordStore ?? createInMemoryRecordStore();
  const recordStore = toRecordStoreLike(records);
  const workspace = localWorkspace(env);
  const capabilities = plugins.find((p) => p.runtime === first.runtime)?.factory.capabilities;

  for (const adapter of adapters) {
    const plugin = plugins.find((p) => p.runtime === adapter.runtime);
    // No plugin for this runtime: an empty binding is still valid for test
    // doubles, whose init() ignores it.
    const binding = plugin ? plugin.localBinding(env) : { runtime: adapter.runtime, config: {} };
    try {
      await adapter.init({ binding, recordStore, workspace, env: { ...env } });
    } catch (err) {
      console.error("[transport-service] adapter init failed", err);
    }
  }

  return {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({ adapter: first, workspace }),
    cors: options.cors ?? { origin: true },
    records,
    capabilities,
  };
}

// Start when run directly (npm run dev / start).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "127.0.0.1";
  const backend = await createBackend();
  const app = await createServer(backend);
  await app.listen({ port, host });
  console.log(`[transport-service] listening on http://localhost:${port}/api/transport`);
}
