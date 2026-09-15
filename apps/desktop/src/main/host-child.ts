import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface HostPorts {
  webPort: number;
  apiPort: number;
}

export function forkHost(input: {
  hostEntry: string;
  nextDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
}): Promise<{ ports: HostPorts; child: ChildProcess }> {
  const child = fork(input.hostEntry, [], {
    cwd: input.cwd,
    env: { ...input.env, DESKTOP_NEXT_DIR: input.nextDir, ELECTRON_RUN_AS_NODE: "1" },
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (d: Buffer) => input.onLine?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => input.onLine?.(d.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("desktop host did not become ready within 60s"));
    }, 60_000);
    child.on("message", (message) => {
      const m = message as { type?: string; webPort?: number; apiPort?: number };
      if (m?.type === "ready" && typeof m.webPort === "number" && typeof m.apiPort === "number") {
        clearTimeout(timer);
        resolve({ ports: { webPort: m.webPort, apiPort: m.apiPort }, child });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (child.pid !== undefined) child.kill("SIGTERM");
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`desktop host exited (${code ?? "signal"})`));
    });
  });
}

export function hostEntryPath(appRoot: string): string {
  return join(appRoot, "build", "host", "host.mjs");
}
