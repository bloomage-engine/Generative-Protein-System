import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getFreePort } from "../shared/net.js";

export interface NextServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function waitForHttp(
  url: string,
  proc: { exitCode: number | null; signalCode?: NodeJS.Signals | null },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`next server exited (${proc.exitCode})`);
    if (proc.signalCode != null) throw new Error(`next server exited (${proc.signalCode})`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`next server did not answer ${url} in ${timeoutMs}ms`);
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(remaining) });
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`next server did not answer ${url} in ${timeoutMs}ms`);
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
  try {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    await waitForHttp(`http://127.0.0.1:${port}/`, child);
  } catch (err) {
    await stopChild(child);
    throw err;
  }
  return { port, close: () => stopChild(child) };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve) => {
    let killTimer: NodeJS.Timeout | undefined;
    const onExit = () => {
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", onExit);
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.kill("SIGTERM");
  });
}
