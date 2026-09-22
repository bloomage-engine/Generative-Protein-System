/**
 * Submitting a Compute Job (docs/adr/0024): the validation and command
 * building are pure (and fully unit-tested); the only effect is a fixed series
 * of SSH runs through the injected {@link SshRunner}, and a ledger row is
 * written ONLY once the remote prints a parseable job id / pid. An ambiguous
 * `sbatch` (exit 0, unparsable id) answers 502 WITHOUT a row and tells the
 * caller to check the cluster before retrying — the runaway guard against a
 * model resubmitting in a loop.
 *
 * The remote command surface is fixed: `mkdir -p && cat > script && sbatch
 * --parsable <script>` for slurm, `mkdir -p && cat > script && cat > runner &&
 * nohup setsid sh <runner> & echo $!` for linux. The linux RUNNER is a tiny
 * uploaded wrapper whose whole job is to redirect the two streams apart and
 * write the exit marker the poller reconciles from — a job that finished
 * invisibly would otherwise sit at `unknown` forever. Interpolated scalars all
 * pass the safe grammar (see `@science-studio/hpc` `isSafeRemotePath`), so no
 * user text is ever re-parsed by a remote shell.
 */
import type { ComputeJob, ComputeJobResources, RecordStore } from "@science-studio/record";
import type { HpcEndpointSettings } from "@science-studio/transport";
import {
  defaultWorkDir,
  isSafeRemotePath,
  jobPaths,
  parseRemotePid,
  parseSlurmJobId,
  type JobPaths,
} from "@science-studio/hpc";
import { remotePath, type SshRunner } from "./ssh.js";

export class HpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HpcError";
  }
}

export interface SubmitInput {
  name: string;
  /** slurm: the full sbatch script; linux: the command line. (`script` and `command` are aliases. */
  script?: string;
  command?: string;
  partition?: string;
  nodes?: number;
  ntasks?: number;
  cpusPerTask?: number;
  mem?: string;
  time?: string;
  /** The submitting Session claim (best-effort, docs/adr/0024). */
  sessionKey?: string;
}

/** A server-minted row id: `cjob-<base36 time>-<rand>`, filename-safe. */
export function mintJobId(now: number = Date.now()): string {
  return `cjob-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A present value must be a positive integer — a typo is a 400, not a drop. */
function requirePositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new HpcError(400, `${key} must be a positive integer`);
}

/** A partition/queue name: word chars, dot, dash — never shell syntax. */
const PARTITION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Slurm wall-time forms: `MM`, `HH:MM:SS`, `D-HH:MM:SS` variants. */
const TIME = /^\d+(-\d+)?(:\d+){0,3}$/;
/** A memory request: `4G`, `512M`, `2GB`, `1024`. */
const MEM = /^\d+(\.\d+)?\s?[KMGT]B?$/i;

/** Validate the (already scope-resolved) submit request body. */
export function parseSubmitBody(body: unknown): SubmitInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "" || name.length > 120) throw new HpcError(400, "name (1-120 chars) is required");
  const script = typeof raw.script === "string" ? raw.script : undefined;
  const command = typeof raw.command === "string" ? raw.command : undefined;
  const text = (script ?? command ?? "").trim();
  if (text === "") throw new HpcError(400, "script (slurm) or command (linux) is required");
  const partition = raw.partition;
  if (partition !== undefined && (typeof partition !== "string" || !PARTITION.test(partition))) {
    throw new HpcError(400, "partition must be a simple queue name");
  }
  const mem = raw.mem;
  if (mem !== undefined && (typeof mem !== "string" || !MEM.test(mem))) {
    throw new HpcError(400, "mem must look like 4G / 512M");
  }
  const time = raw.time;
  if (time !== undefined && (typeof time !== "string" || !TIME.test(time))) {
    throw new HpcError(400, "time must be slurm wall-time (e.g. 60, or 4:00:00)");
  }
  const nodes = requirePositiveInt(raw.nodes, "nodes");
  const ntasks = requirePositiveInt(raw.ntasks, "ntasks");
  const cpusPerTask = requirePositiveInt(raw.cpusPerTask, "cpusPerTask");
  const sessionKey =
    typeof raw.sessionKey === "string" && raw.sessionKey !== "" ? raw.sessionKey : undefined;
  return {
    name,
    ...(script !== undefined ? { script } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(typeof partition === "string" ? { partition } : {}),
    ...(nodes !== undefined ? { nodes } : {}),
    ...(ntasks !== undefined ? { ntasks } : {}),
    ...(cpusPerTask !== undefined ? { cpusPerTask } : {}),
    ...(typeof mem === "string" ? { mem } : {}),
    ...(typeof time === "string" ? { time } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** The job body text however the caller spelled it (script for slurm, command for linux). */
function submitText(input: SubmitInput): string {
  return (input.script ?? input.command ?? "").trim();
}

/**
 * Prepend the `#SBATCH` directive header the service controls (id, log paths,
 * resource lines) ABOVE the submitted script — a self-authored `#SBATCH` in
 * the body still applies (Slurm's last-directive-wins), which is the
 * documented convention: the caller overrides, the service defaults.
 */
export function buildSbatchScript(
  input: SubmitInput,
  endpoint: HpcEndpointSettings,
  defaults: { partition?: string; time?: string },
  paths: JobPaths,
  rowId: string,
): string {
  const lines = [
    `#SBATCH --job-name=${rowId}`,
    `#SBATCH --output=${paths.stdout}`,
    `#SBATCH --error=${paths.stderr}`,
  ];
  const partition = input.partition ?? defaults.partition ?? endpoint.defaultPartition;
  if (partition && !PARTITION.test(partition)) {
    throw new HpcError(400, `invalid partition "${partition}" (Binding/endpoint default)`);
  }
  if (partition) lines.push(`#SBATCH --partition=${partition}`);
  const time = input.time ?? defaults.time ?? endpoint.defaultTime;
  if (time && !TIME.test(time)) {
    throw new HpcError(400, `invalid default time "${time}" (Binding/endpoint default)`);
  }
  if (time) lines.push(`#SBATCH --time=${time}`);
  if (input.nodes !== undefined) lines.push(`#SBATCH --nodes=${input.nodes}`);
  if (input.ntasks !== undefined) lines.push(`#SBATCH --ntasks=${input.ntasks}`);
  if (input.cpusPerTask !== undefined) lines.push(`#SBATCH --cpus-per-task=${input.cpusPerTask}`);
  if (input.mem !== undefined) lines.push(`#SBATCH --mem=${input.mem.replace(/\s+/g, "")}`);
  return `${lines.join("\n")}\n\n${submitText(input)}\n`;
}

/**
 * The fixed command trio for a slurm submit: make the job dir, upload the
 * composed script (so the ledger snapshot and the remote bytes are the same
 * file), then `sbatch --parsable` it.
 */
export function slurmCommands(paths: JobPaths): { mkdir: string; upload: string; sbatch: string } {
  return {
    mkdir: `mkdir -p ${remotePath(paths.dir)}`,
    upload: `cat > ${remotePath(paths.script)}`,
    sbatch: `sbatch --parsable ${remotePath(paths.script)}`,
  };
}

/**
 * The fixed command quartet for a linux endpoint. The uploaded RUNNER is the
 * whole exit-marker story: it splits the streams (stdout and stderr are both
 * tailable) and writes `rc` when the command finishes, so the poller can
 * settle the row to completed/failed instead of watching it vanish.
 */
export function linuxCommands(paths: JobPaths): { mkdir: string; upload: string; runner: string; run: string } {
  return {
    mkdir: `mkdir -p ${remotePath(paths.dir)}`,
    upload: `cat > ${remotePath(paths.script)}`,
    runner: `cat > ${remotePath(paths.runner)}`,
    run:
      `nohup setsid sh ${remotePath(paths.runner)} </dev/null >/dev/null 2>&1 ` +
      `& echo $! >${remotePath(paths.pid)}; cat ${remotePath(paths.pid)}`,
  };
}

/**
 * The runner body. Paths are interpolated BARE — the safe grammar forbids
 * spaces/metachars, and a leading `~` expands per word as the remote sh runs
 * the file, which quoting would break (a quoted `~` is a literal directory).
 */
export function buildLinuxRunner(paths: JobPaths): string {
  return ["#!/bin/sh", `sh ${paths.script} >${paths.stdout} 2>${paths.stderr}`, `echo $? >${paths.rc}`, ""].join("\n");
}

export interface SubmitDeps {
  ssh: SshRunner;
  records: RecordStore;
  /** Read the endpoint's live Binding: workDir override + partition/time defaults. */
  bindingOf(projectId: string): Promise<BindingView | null>;
  endpoints(): Promise<HpcEndpointSettings[]>;
  now?: () => string;
}

export interface BindingView {
  endpoint: string;
  workDir?: string;
  partition?: string;
  defaultTime?: string;
}

export function resolveEndpoint(
  endpoints: HpcEndpointSettings[],
  binding: BindingView | null,
): HpcEndpointSettings {
  if (!binding) throw new HpcError(400, "this Project is not bound to an HPC endpoint");
  const endpoint = endpoints.find((e) => e.id === binding.endpoint);
  if (!endpoint) {
    throw new HpcError(400, `the Project binding names an unknown endpoint "${binding.endpoint}"`);
  }
  return endpoint;
}

export function resolveWorkDir(projectId: string, binding: BindingView): string {
  const dir = binding.workDir ?? defaultWorkDir(projectId);
  if (!isSafeRemotePath(dir)) throw new HpcError(400, "the Binding's workDir is not a safe remote path");
  return dir;
}

/** The runaway guard: cap the Project's non-terminal rows on this endpoint. */
export function assertWithinCap(
  openOnEndpoint: ComputeJob[],
  endpoint: HpcEndpointSettings,
): void {
  const cap = endpoint.maxConcurrentJobs ?? 0;
  if (cap > 0 && openOnEndpoint.length >= cap) {
    throw new HpcError(429, `endpoint "${endpoint.id}" is at its ${cap}-job cap — wait for a run to finish`);
  }
}

/**
 * Submit one Compute Job and write its ledger row. `getOpenJobs` supplies the
 * Project's non-terminal rows (for the cap); the row is written only after a
 * parseable remote answer (see the module header).
 */
export async function submitJob(
  deps: SubmitDeps,
  args: { projectId: string; input: SubmitInput; getOpenJobs: () => Promise<ComputeJob[]> },
): Promise<ComputeJob> {
  const now = deps.now ?? (() => new Date().toISOString());
  const [binding, endpoints] = await Promise.all([
    deps.bindingOf(args.projectId),
    deps.endpoints(),
  ]);
  const endpoint = resolveEndpoint(endpoints, binding ?? null);
  assertWithinCap((await args.getOpenJobs()).filter((j) => j.endpointId === endpoint.id), endpoint);
  const workDir = resolveWorkDir(args.projectId, binding!);
  const rowId = mintJobId();
  const paths = jobPaths(workDir, rowId);

  let remoteJobId: string;
  let rowScript: string | undefined;
  let rowCommand: string | undefined;
  if (endpoint.kind === "slurm") {
    const cmds = slurmCommands(paths);
    const script = buildSbatchScript(
      args.input,
      endpoint,
      {
        ...(binding!.partition ? { partition: binding!.partition } : {}),
        ...(binding!.defaultTime ? { time: binding!.defaultTime } : {}),
      },
      paths,
      rowId,
    );
    const mkdir = await deps.ssh.run(endpoint, cmds.mkdir);
    if (mkdir.code !== 0) throw new HpcError(502, `remote mkdir failed: ${mkdir.stderr || mkdir.stdout}`);
    const upload = await deps.ssh.run(endpoint, cmds.upload, { stdin: script });
    if (upload.code !== 0) {
      throw new HpcError(502, `remote script write failed: ${upload.stderr || upload.stdout}`);
    }
    const res = await deps.ssh.run(endpoint, cmds.sbatch);
    if (res.code !== 0) {
      throw new HpcError(502, `sbatch failed: ${res.stderr || res.stdout}`);
    }
    const id = parseSlurmJobId(res.stdout);
    if (id === null) {
      throw new HpcError(
        502,
        "sbatch reported success but no job id was readable — the job may be queued; check before retrying",
      );
    }
    remoteJobId = id;
    rowScript = script;
  } else {
    const cmds = linuxCommands(paths);
    const command = submitText(args.input);
    const mkdir = await deps.ssh.run(endpoint, cmds.mkdir);
    if (mkdir.code !== 0) throw new HpcError(502, `remote mkdir failed: ${mkdir.stderr || mkdir.stdout}`);
    const write = await deps.ssh.run(endpoint, cmds.upload, { stdin: `${command}\n` });
    if (write.code !== 0) {
      throw new HpcError(502, `remote script write failed: ${write.stderr || write.stdout}`);
    }
    const runner = await deps.ssh.run(endpoint, cmds.runner, { stdin: buildLinuxRunner(paths) });
    if (runner.code !== 0) {
      throw new HpcError(502, `remote runner write failed: ${runner.stderr || runner.stdout}`);
    }
    const run = await deps.ssh.run(endpoint, cmds.run);
    const pid = parseRemotePid(run.stdout);
    if (pid === null) {
      throw new HpcError(502, `remote run did not report a pid: ${run.stderr || run.stdout}`);
    }
    remoteJobId = pid;
    rowCommand = command;
  }

  const at = now();
  const job: ComputeJob = {
    id: rowId,
    projectId: args.projectId,
    endpointId: endpoint.id,
    kind: endpoint.kind,
    remoteJobId,
    name: args.input.name,
    ...(rowScript !== undefined ? { script: rowScript } : {}),
    ...(rowCommand !== undefined ? { command: rowCommand } : {}),
    state: endpoint.kind === "slurm" ? "pending" : "submitted",
    remoteDir: paths.dir,
    submittedAt: at,
    updatedAt: at,
    ...(args.input.sessionKey ? { sessionKey: args.input.sessionKey } : {}),
  };
  const resources: ComputeJobResources = {};
  if (args.input.partition) resources.partition = args.input.partition;
  if (args.input.nodes !== undefined) resources.nodes = args.input.nodes;
  if (args.input.ntasks !== undefined) resources.ntasks = args.input.ntasks;
  if (args.input.cpusPerTask !== undefined) resources.cpusPerTask = args.input.cpusPerTask;
  if (args.input.mem) resources.mem = args.input.mem;
  if (args.input.time) resources.time = args.input.time;
  if (Object.keys(resources).length > 0) job.resources = resources;
  await deps.records.upsertComputeJob(job);
  return job;
}
