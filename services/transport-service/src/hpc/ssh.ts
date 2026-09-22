/**
 * The ONLY SSH client in the product (docs/adr/0024): the service spawns the
 * system OpenSSH binaries rather than embedding an SSH library, so real keys,
 * `ssh-agent` and the operator's `~/.ssh/config` work exactly as the site's
 * admins expect. Every remote invocation is a fixed argv — user-derived
 * scalars reach the remote shell only through `shq`/`remotePath` — and remote
 * output is data, never eval'd.
 *
 * `ControlMaster` sockets live under the service's tmp dir (0600), unique per
 * endpoint id; `ControlPersist` lets a dead master self-expire, so there is no
 * pool to manage and a killed service leaks at most a socket file.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shq } from "@science-studio/hpc";
import type { HpcEndpointSettings } from "@science-studio/transport";

export interface SshResult {
  /** Process exit code; -1 when the deadline killed the client. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  stdin?: string;
  timeoutMs?: number;
}

/** What the HPC surface needs from a remote shell — fakeable in tests. */
export interface SshRunner {
  run(endpoint: HpcEndpointSettings, command: string, opts?: SshRunOptions): Promise<SshResult>;
  copyTo(endpoint: HpcEndpointSettings, localPath: string, remotePath: string): Promise<SshResult>;
  copyFrom(endpoint: HpcEndpointSettings, remote: string, localPath: string): Promise<SshResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** `[user@]host` as ssh wants it; a bare host defers to `~/.ssh/config`. */
export function sshTarget(endpoint: HpcEndpointSettings): string {
  return endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host;
}

/** The shared `-o` set: never interactive, always multiplexed, accept-new keys. */
export function sshOptions(controlPath: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=600",
  ];
}

/** `ssh <opts> [-p port] [-i keyPath] target command` — the fixed argv. */
export function buildSshArgs(
  endpoint: HpcEndpointSettings,
  controlPath: string,
  command: string,
): string[] {
  const args = [...sshOptions(controlPath)];
  if (typeof endpoint.port === "number") args.push("-p", String(endpoint.port));
  if (endpoint.keyPath) args.push("-i", endpoint.keyPath);
  args.push(sshTarget(endpoint), command);
  return args;
}

export function buildScpArgs(
  endpoint: HpcEndpointSettings,
  controlPath: string,
  localPath: string,
  remotePath: string,
  toRemote: boolean,
): string[] {
  // scp shares ssh's whole option set: a cold ControlMaster must not fall back
  // to interactive defaults (BatchMode, ConnectTimeout, accept-new).
  const args = [...sshOptions(controlPath)];
  if (typeof endpoint.port === "number") args.push("-P", String(endpoint.port));
  if (endpoint.keyPath) args.push("-i", endpoint.keyPath);
  const target = `${sshTarget(endpoint)}:${remotePath}`;
  args.push(toRemote ? localPath : target, toRemote ? target : localPath);
  return args;
}

/**
 * A shell expression for a remote path. A leading `~` is a SHELL construct —
 * quoting it would create a literal `~` directory — so it is rewritten to the
 * `$HOME` variable (unquoted by design) and only the remainder is `shq`-escaped.
 */
export function remotePath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

function exec(
  bin: string,
  args: string[],
  opts: SshRunOptions,
): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: `${stderr}\nssh client timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export interface SshRunnerOptions {
  /** Test/env seam: the `ssh` binary (a shim makes an offline cluster emulatable). */
  sshBin?: string;
  scpBin?: string;
  /** Where ControlMaster sockets live; defaults under the temp dir. */
  controlDir?: string;
}

export async function createSshRunner(opts: SshRunnerOptions = {}): Promise<SshRunner> {
  const sshBin = opts.sshBin ?? process.env.SS_SSH_BIN ?? "ssh";
  const scpBin = opts.scpBin ?? process.env.SS_SCP_BIN ?? "scp";
  const base = opts.controlDir ?? join(tmpdir(), "science-studio", "hpc");
  // One master dir per service process (unique temp dir under `base`), created
  // lazily; a per-endpoint socket name keeps masters from sharing. `sun_path`
  // stays far below its bound: `mkdtemp(cm-XXXXXX)/<endpointId>.sock`.
  let dirPromise: Promise<string> | null = null;
  const socket = async (endpoint: HpcEndpointSettings): Promise<string> => {
    dirPromise ??= mkdtemp(join(base, "cm-"));
    const dir = await dirPromise;
    return join(dir, `${endpoint.id}.sock`);
  };

  return {
    async run(endpoint, command, runOpts = {}) {
      const path = await socket(endpoint);
      return exec(sshBin, [...buildSshArgs(endpoint, path, command)], runOpts);
    },
    async copyTo(endpoint, localPath, remote) {
      const path = await socket(endpoint);
      return exec(scpBin, buildScpArgs(endpoint, path, localPath, remote, true), {});
    },
    async copyFrom(endpoint, remote, localPath) {
      const path = await socket(endpoint);
      return exec(scpBin, buildScpArgs(endpoint, path, localPath, remote, false), {});
    },
  };
}


