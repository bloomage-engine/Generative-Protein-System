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
  // The dsh child's HPC/worktree tools fetch /api/* from the SERVICE's port.
  // host-main passes process.env here, so the adapter sees this before its lazy
  // first-use init; without it those tools keep the dev default (3001).
  options.env.GPS_SERVICE_URL = apiBaseUrl;
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
  const { createBackend, createTransportService } = await import("@gps/transport-service");
  const { runtimePlugins } = await import("@gps/transport-dsh");
  const backend = await createBackend(env, runtimePlugins);
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // The packaged host owns the process, so it must start the cron controller
  // itself: `index.ts`'s `isMain` branch never runs here (its `onClose` hook
  // stops the scheduler). Same for the HPC job poller (docs/adr/0024) — without
  // it the Compute Job ledger would freeze at submit state in the Desktop App.
  // Set the service URL BEFORE starting them: a task due on the first tick must
  // see the real port, not the dev default 3001.
  env.GPS_SERVICE_URL = `http://127.0.0.1:${port}`;
  app.cronScheduler.start();
  app.hpcPoller.start();
  return { port, close: () => app.close() };
}
