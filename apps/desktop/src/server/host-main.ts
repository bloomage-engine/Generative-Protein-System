import { startHost } from "./host.js";
import { reportReady } from "./report.js";

const nextDir = process.env.DESKTOP_NEXT_DIR;
if (!nextDir) {
  process.stderr.write("[desktop-host] DESKTOP_NEXT_DIR is required\n");
  process.exit(1);
}

startHost({ nextDir, env: process.env, log: (line) => process.stderr.write(line) })
  .then((host) => {
    const shutdown = () => {
      host.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    reportReady({ webPort: host.webPort, apiPort: host.apiPort });
  })
  .catch((err) => {
    process.stderr.write(`[desktop-host] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
