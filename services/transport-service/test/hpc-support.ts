/** Shared fakes for the HPC service tests (NOT a *.test.ts — just helpers). */
import type { HpcEndpointSettings } from "@science-studio/transport";
import type { SshResult, SshRunner } from "../src/hpc/ssh.js";

export const ENDPOINT: HpcEndpointSettings = {
  id: "cluster-a",
  name: "Cluster A",
  kind: "slurm",
  host: "hpc.example",
  user: "alice",
  keyPath: "/home/alice/.ssh/id_ed25519",
  defaultPartition: "gpu",
  defaultTime: "2:00:00",
};

export const LINUX_ENDPOINT: HpcEndpointSettings = {
  ...ENDPOINT,
  id: "box-1",
  kind: "linux",
  defaultPartition: undefined,
  defaultTime: undefined,
};

export interface SshCall {
  command: string;
  stdin?: string;
}

/** A scripted runner: the FIRST matching `answers` entry replies; default is exit 0. */
export function fakeSsh(
  answers: Array<{ match: RegExp; result: Partial<SshResult> | ((call: SshCall) => Partial<SshResult>) }> = [],
): SshRunner & { calls: SshCall[] } {
  const calls: SshCall[] = [];
  const ok = (over: Partial<SshResult> = {}): SshResult => ({ code: 0, stdout: "", stderr: "", ...over });
  return {
    calls,
    async run(_endpoint, command, opts = {}) {
      const call: SshCall = { command, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) };
      calls.push(call);
      for (const a of answers) {
        if (!a.match.test(command)) continue;
        return ok(typeof a.result === "function" ? a.result(call) : a.result);
      }
      return ok();
    },
    async copyTo(_e, localPath, remote) {
      calls.push({ command: `scp-to ${localPath} ${remote}` });
      return ok();
    },
    async copyFrom(_e, remote, localPath) {
      calls.push({ command: `scp-from ${remote} ${localPath}` });
      return ok();
    },
  };
}
