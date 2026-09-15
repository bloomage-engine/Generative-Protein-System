import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getFreePort } from "../shared/net.js";

export interface NextServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function waitForHttp(
  url: string,
  proc: { exitCode: number | null },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`next server exited (${proc.exitCode})`);
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`next server did not answer ${url} in ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function startNextServer(input: {
  nextDir: string;
  apiBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Promise<NextServerHandle> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [join(input.nextDir, "server.js")], {
    cwd: input.nextDir,
    env: {
      ...process.env,
      ...input.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      TRANSPORT_SERVICE_URL: input.apiBaseUrl,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => input.log?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => input.log?.(d.toString()));
  await waitForHttp(`http://127.0.0.1:${port}/`, child);
  return { port, close: () => stopChild(child) };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
