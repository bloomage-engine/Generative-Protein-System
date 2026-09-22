import { startNextServer, type NextServerHandle } from "./next.js";

export interface HostHandle {
  webPort: number;
  apiPort: number;
  close(): Promise<void>;
}

export async function startHost(options: {
  nextDir: string;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  startWeb?: typeof startNextServer;
  startApi?: (env: NodeJS.ProcessEnv) => Promise<{ port: number; close(): Promise<void> }>;
}): Promise<HostHandle> {
  const startApi = options.startApi ?? defaultStartApi;
  const startWeb = options.startWeb ?? startNextServer;
  const api = await startApi(options.env);
  const apiBaseUrl = `http://127.0.0.1:${api.port}`;
  let web: NextServerHandle;
  try {
    web = await startWeb({ nextDir: options.nextDir, apiBaseUrl, env: options.env, log: options.log });
  } catch (err) {
    await api.close();
    throw err;
  }
  return {
    webPort: web.port,
    apiPort: api.port,
    async close() {
      let firstError: unknown;
      try {
        await web.close();
      } catch (err) {
        firstError = err;
      }
      try {
        await api.close();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

async function defaultStartApi(env: NodeJS.ProcessEnv): Promise<{ port: number; close(): Promise<void> }> {
  const { createBackend, createTransportService } = await import("@science-studio/transport-service");
  const { runtimePlugins } = await import("@science-studio/transport-dsh");
  const backend = await createBackend(env, runtimePlugins);
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  // The packaged host owns the process, so it must start the cron controller
  // itself: `index.ts`'s `isMain` branch never runs here (its `onClose` hook
  // stops the scheduler). Same for the HPC job poller (docs/adr/0024) — without
  // it the Compute Job ledger would freeze at submit state in the Desktop App.
  app.cronScheduler.start();
  app.hpcPoller.start();
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => app.close() };
}
