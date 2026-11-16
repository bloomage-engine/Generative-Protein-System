import { spawn, type ChildProcess } from "node:child_process";

export interface TreeKillCommand {
  command: string;
  args: string[];
}

/** Windows has no SIGKILL that reaches grandchildren; taskkill /T owns the tree. */
export function treeKillCommand(platform: NodeJS.Platform, pid: number): TreeKillCommand | null {
  if (platform !== "win32") return null;
  return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
}

export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const command = child.pid === undefined ? null : treeKillCommand(platform, child.pid);
  if (command === null) {
    child.kill("SIGKILL");
    return;
  }
  spawn(command.command, command.args, { stdio: "ignore", windowsHide: true }).unref();
}
