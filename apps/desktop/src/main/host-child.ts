import { fork, type ChildProcess } from "node:child_process";
import { killTree } from "../shared/process-tree.js";

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
  const tail: string[] = [];
  child.stdout?.on("data", (d: Buffer) => input.onLine?.(d.toString()));
  child.stderr?.on("data", (d: Buffer) => {
    const text = d.toString();
    input.onLine?.(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      tail.push(line);
      if (tail.length > 20) tail.shift();
    }
  });
  return new Promise((resolve, reject) => {
    const detail = (): string => (tail.length === 0 ? "" : `\n${tail.join("\n")}`);
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onExit);
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
      killTree(child);
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`desktop host exited (${code ?? "signal"})${detail()}`));
    };
    timer = setTimeout(() => {
      killTree(child);
      cleanup();
      reject(new Error(`desktop host did not become ready within 60s${detail()}`));
    }, 60_000);
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("close", onExit);
  });
}
