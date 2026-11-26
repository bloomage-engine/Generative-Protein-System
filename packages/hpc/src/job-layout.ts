/**
 * The Remote Work Dir and per-job-dir layout (docs/adr/0024): the path
 * conventions the service writes and the Jobs panel reads, in one pure module
 * so submit, poller and logs can never disagree.
 *
 * Remote paths are ONLY ever assembled from server-generated ids and the
 * (human-authored) binding workDir — never from a remote reply — and every
 * interpolation into a remote shell command goes through `shq` first. The
 * job dir hides under a dot-dir so a listing of the Remote Work Dir stays
 * about the RESEARCH, not the plumbing.
 */

/** A Compute Job row id: server-minted, filename-safe, the ledger's key. */
const COMPUTE_JOB_ID = /^cjob-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidComputeJobId(id: string): boolean {
  return COMPUTE_JOB_ID.test(id);
}

/** The convention when a Binding names no `workDir`. */
export function defaultWorkDir(projectId: string): string {
  return `~/gps/${projectId}`;
}

/** The per-job dir: pid/rc/log files for a `linux` job, `-o/-e` home for slurm. */
export function jobDir(workDir: string, jobId: string): string {
  const base = workDir.endsWith("/") ? workDir.slice(0, -1) : workDir;
  return `${base}/.gps-jobs/${jobId}`;
}

export interface JobPaths {
  dir: string;
  script: string;
  /** The detached wrapper a `linux` job actually runs (upload → redirect → exit marker). */
  runner: string;
  stdout: string;
  stderr: string;
  pid: string;
  rc: string;
}

export function jobPaths(workDir: string, jobId: string): JobPaths {
  const dir = jobDir(workDir, jobId);
  return {
    dir,
    script: `${dir}/script.sh`,
    runner: `${dir}/run.sh`,
    stdout: `${dir}/stdout`,
    stderr: `${dir}/stderr`,
    pid: `${dir}/pid`,
    rc: `${dir}/rc`,
  };
}

/** POSIX single-quote escape — the one way a scalar reaches a remote shell. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Remote paths (a Binding's `workDir`) reach `ssh`/`sbatch`/`scp` unquoted in
 * places no `shq` can reach (the `#SBATCH` header, scp destination parsing), so
 * the product restricts them to a space-free grammar and rejects traversal.
 * That is the whole quoting story: nothing else is interpolated raw.
 */
const SAFE_REMOTE_PATH = /^[A-Za-z0-9._~/-]+$/;

export function isSafeRemotePath(path: string): boolean {
  if (!SAFE_REMOTE_PATH.test(path)) return false;
  if (path.startsWith("-")) return false; // never an argv flag
  return !path.split("/").includes("..");
}

/** A slurm job id is numeric; parse `sbatch --parsable` output (`id` or `id;cluster`). */
export function parseSlurmJobId(output: string): string | null {
  const match = output.trim().match(/^(\d+)(?:;.*)?$/);
  const id = match?.[1];
  return typeof id === "string" ? id : null;
}

/** A linux pid is a positive decimal integer (from the remote `echo $!`). */
export function parseRemotePid(output: string): string | null {
  const trimmed = output.trim();
  return /^[1-9]\d*$/.test(trimmed) ? trimmed : null;
}
