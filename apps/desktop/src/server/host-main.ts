import { startHost } from "./host.js";
import { reportReady } from "./report.js";

const nextDir = process.env.DESKTOP_NEXT_DIR;
if (!nextDir) {
  process.stderr.write("[desktop-host] DESKTOP_NEXT_DIR is required\n");
  process.exit(1);
}

startHost({ nextDir, env: process.env, log: (line) => process.stderr.write(line) })
  .then((host) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      host.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // Windows delivers no SIGTERM to a child; the fork's IPC channel is the
    // graceful path the main process uses before its taskkill fallback.
    process.on("message", (message: unknown) => {
      if ((message as { type?: string } | null)?.type === "shutdown") shutdown();
    });
    reportReady({ webPort: host.webPort, apiPort: host.apiPort });
  })
  .catch((err) => {
    process.stderr.write(`[desktop-host] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
