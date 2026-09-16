import { fork, type ChildProcess } from "node:child_process";

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
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      const m = message as { type?: string; webPort?: number; apiPort?: number };
      if (m?.type === "ready" && typeof m.webPort === "number" && typeof m.apiPort === "number") {
        cleanup();
        resolve({ ports: { webPort: m.webPort, apiPort: m.apiPort }, child });
      }
    };
    const onError = (err: Error) => {
      cleanup();
      if (child.pid !== undefined) child.kill("SIGTERM");
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`desktop host exited (${code ?? "signal"})`));
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      cleanup();
      reject(new Error("desktop host did not become ready within 60s"));
    }, 60_000);
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
