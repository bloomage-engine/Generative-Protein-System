/**
 * The HPC job poller (docs/adr/0024): the cron scheduler's shape — a
 * decorated, `isMain`-started controller whose `tick()` tests can drive.
 * It is the ONLY thing that asks a cluster for state: the ledger it writes
 * is the panel's and the tools' read model.
 *
 * Rules (frozen in design): only OUR submitted rows are ever tracked (no
 * queue scanning for foreign jobs); a project with no open row costs zero
 * SSH; a slurm row leaves `squeue` exactly once → one `sacct` pass settles
 * the terminal state; a `linux` row is a pid probe plus its exit marker;
 * repeated failures settle to `unknown` and stop polling after three
 * strikes (a manual refresh resets the strikes).
 */
import type { ComputeJob, Id, RecordStore } from "@science-studio/record";
import { isOpenComputeJobState } from "@science-studio/hpc";
import type { HpcEndpointSettings } from "@science-studio/transport";
import { parseExitCode, sacctStateToJobState, squeueStateToJobState } from "@science-studio/hpc";
import { remotePath, type SshRunner } from "./ssh.js";

declare module "fastify" {
  interface FastifyInstance {
    hpcPoller: HpcJobPoller;
  }
}

export interface HpcJobPoller {
  /** Reconcile the open rows; returns the number of rows touched. */
  tick(opts?: { projectId?: Id; resetStrikes?: boolean }): Promise<number>;
  start(): void;
  stop(): void;
}

export interface HpcPollerDeps {
  records: RecordStore;
  /** Every non-archived Project id (the service's directory). */
  projects(): Promise<Id[]>;
  /** Re-read per tick — endpoint edits are hot (docs/adr/0024). */
  endpoints(): Promise<HpcEndpointSettings[]>;
  ssh: SshRunner;
  now?: () => string;
  tickMs?: number;
  onError?: (err: unknown) => void;
}

const STRIKES_BEFORE_UNKNOWN = 3;

function isOpen(job: ComputeJob): boolean {
  return isOpenComputeJobState(job.state);
}

function numericId(id: string | undefined): id is string {
  return typeof id === "string" && /^\d+$/.test(id);
}

/** Split `sacct -P`'s pipe-delimited record, keeping the first field exact. */
function parsePipes(line: string): string[] {
  return line.split("|").map((cell) => cell.trim());
}

/** Slurm timestamps are ISO-ish; an unparsable one (or `N/A`) yields none. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw || raw === "N/A") return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function createHpcPoller(deps: HpcPollerDeps): HpcJobPoller {
  const now = deps.now ?? (() => new Date().toISOString());
  const tickMs = deps.tickMs ?? 15_000;
  const onError = deps.onError ?? ((err) => console.error("[transport-service] hpc tick failed", err));
  /** Consecutive reconcile failures per row id; a manual tick resets them. */
  const strikes = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const failRow = (job: ComputeJob, reason: string): ComputeJob | null => {
    const count = (strikes.get(job.id) ?? 0) + 1;
    strikes.set(job.id, count);
    const next: ComputeJob = { ...job, error: reason, updatedAt: now() };
    if (count >= STRIKES_BEFORE_UNKNOWN && job.state !== "unknown") next.state = "unknown";
    return count === STRIKES_BEFORE_UNKNOWN || job.state !== next.state || job.error !== reason
      ? next
      : null;
  };

  const settleSlurm = async (
    endpoint: HpcEndpointSettings,
    job: ComputeJob,
  ): Promise<ComputeJob | null> => {
    const res = await deps.ssh.run(
      endpoint,
      `sacct -n -P -X -j ${job.remoteJobId} --format=JobID,State,ExitCode,Start,End,NodeList 2>/dev/null || true`,
    );
    if (res.code !== 0) return failRow(job, `sacct failed: ${res.stderr.trim() || "ssh error"}`);
    const line = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map(parsePipes)
      .find((cells) => cells[0] === job.remoteJobId);
    if (!line) return failRow(job, "no longer visible in squeue or sacct");
    const state = sacctStateToJobState(line[1] ?? "");
    if (state === "pending" || state === "running") {
      // Still alive on the cluster (a squeue/sacct race) — keep last known, no strike.
      return null;
    }
    if (state === "unknown") {
      return failRow(job, `unrecognized sacct state "${line[1]}"`);
    }
    const exit = parseExitCode(line[2] ?? "");
    const next: ComputeJob = {
      ...job,
      state,
      nodeList: line[5] && line[5] !== "N/A" ? line[5] : job.nodeList,
      finishedAt: toIso(line[4]) ?? now(),
      startedAt: job.startedAt ?? toIso(line[3]) ?? job.submittedAt,
      error: undefined,
      updatedAt: now(),
    };
    if (exit !== undefined) next.exitCode = exit;
    strikes.delete(job.id);
    return next;
  };

  const reconcileSlurm = async (
    endpoint: HpcEndpointSettings,
    jobs: ComputeJob[],
    out: ComputeJob[],
  ): Promise<void> => {
    const tracked = jobs.filter((j) => numericId(j.remoteJobId));
    for (const job of jobs) {
      if (!numericId(job.remoteJobId)) {
        const next = failRow(job, "row carries no numeric job id");
        if (next) out.push(next);
      }
    }
    if (tracked.length === 0) return;
    const ids = tracked.map((j) => j.remoteJobId).join(",");
    const res = await deps.ssh.run(
      endpoint,
      `squeue -h -o "%i|%T|%P|%N|%r" --job=${ids} 2>/dev/null || true`,
    );
    if (res.code !== 0) {
      for (const job of tracked) {
        const next = failRow(job, `squeue failed: ${res.stderr.trim() || "ssh error"}`);
        if (next) out.push(next);
      }
      return;
    }
    const seen = new Map<string, { state: string; nodes: string; reason: string }>();
    for (const line of res.stdout.split("\n")) {
      const cells = parsePipes(line);
      if (cells.length >= 2 && numericId(cells[0])) {
        seen.set(cells[0], { state: cells[1] ?? "", nodes: cells[3] ?? "", reason: cells[4] ?? "" });
      }
    }
    for (const job of tracked) {
      const live = seen.get(job.remoteJobId!);
      if (live) {
        const state = squeueStateToJobState(live.state);
        const next: ComputeJob = {
          ...job,
          state: state === "unknown" ? job.state : state,
          nodeList: live.nodes && live.nodes !== "N/A" ? live.nodes : job.nodeList,
          startedAt: job.startedAt ?? (state === "running" ? now() : undefined),
          error:
            state === "unknown"
              ? `unrecognized squeue state "${live.state}"`
              : live.reason && live.reason !== "None"
                ? live.reason
                : undefined,
          updatedAt: now(),
        };
        if (next.state !== job.state || next.error !== job.error || next.nodeList !== job.nodeList) out.push(next);
        if (state !== "unknown") strikes.delete(job.id);
        continue;
      }
      // Gone from squeue: settle once through sacct.
      const settled = await settleSlurm(endpoint, job);
      if (settled) out.push(settled);
    }
  };

  const reconcileLinux = async (
    endpoint: HpcEndpointSettings,
    jobs: ComputeJob[],
    out: ComputeJob[],
  ): Promise<void> => {
    const probes = jobs.filter((j) => j.remoteDir && numericId(j.remoteJobId));
    for (const job of jobs) {
      if (!job.remoteDir || !numericId(job.remoteJobId)) {
        const next = failRow(job, "row carries no remote dir/pid");
        if (next) out.push(next);
      }
    }
    if (probes.length === 0) return;
    const script = probes
      .map((job) => {
        const dir = remotePath(job.remoteDir!);
        return (
          `if [ -f ${dir}/rc ]; then echo "${job.id} RC $(cat ${dir}/rc)"; ` +
          `elif [ -f ${dir}/pid ] && kill -0 $(cat ${dir}/pid) 2>/dev/null; then echo "${job.id} LIVE"; ` +
          `else echo "${job.id} GONE"; fi`
        );
      })
      .join("; ");
    const res = await deps.ssh.run(endpoint, script);
    if (res.code !== 0) {
      for (const job of probes) {
        const next = failRow(job, `probe failed: ${res.stderr.trim() || "ssh error"}`);
        if (next) out.push(next);
      }
      return;
    }
    const answers = new Map<string, string[]>();
    for (const line of res.stdout.split("\n")) {
      const cells = line.trim().split(/\s+/);
      const head = cells[0];
      if (cells.length >= 2 && head && head.startsWith("cjob-")) answers.set(head, cells.slice(1));
    }
    for (const job of probes) {
      const answer = answers.get(job.id);
      if (!answer) {
        const next = failRow(job, "probe produced no answer");
        if (next) out.push(next);
        continue;
      }
      const kind = answer[0];
      if (kind === "RC") {
        const code = Number(answer[1] ?? "1");
        strikes.delete(job.id);
        out.push({
          ...job,
          state: code === 0 ? "completed" : "failed",
          exitCode: Number.isSafeInteger(code) ? code : undefined,
          finishedAt: now(),
          startedAt: job.startedAt ?? job.submittedAt,
          error: undefined,
          updatedAt: now(),
        });
      } else if (kind === "LIVE") {
        strikes.delete(job.id);
        if (job.state === "running") continue; // stable — no row churn
        out.push({
          ...job,
          state: "running",
          startedAt: job.startedAt ?? now(),
          error: undefined,
          updatedAt: now(),
        });
      } else {
        const next = failRow(job, "process is gone without an exit marker");
        if (next) out.push(next);
      }
    }
  };

  const reconcile = async (jobs: ComputeJob[], out: ComputeJob[]): Promise<void> => {
    const endpoints = await deps.endpoints();
    const byEndpoint = new Map<string, ComputeJob[]>();
    for (const job of jobs) {
      const endpoint = endpoints.find((e) => e.id === job.endpointId);
      if (!endpoint) {
        const next = failRow(job, "the endpoint was deleted from the deployment settings");
        if (next) out.push(next);
        continue;
      }
      const list = byEndpoint.get(endpoint.id) ?? [];
      list.push(job);
      byEndpoint.set(endpoint.id, list);
    }
    for (const [endpointId, group] of byEndpoint) {
      const endpoint = endpoints.find((e) => e.id === endpointId)!;
      try {
        if (endpoint.kind === "slurm") await reconcileSlurm(endpoint, group, out);
        else await reconcileLinux(endpoint, group, out);
      } catch (err) {
        // One endpoint must never suspend the rest of the tick (cron's rule).
        onError(err);
      }
    }
  };

  const tick = async (opts: { projectId?: Id; resetStrikes?: boolean } = {}): Promise<number> => {
    const touched: ComputeJob[] = [];
    const projects = opts.projectId ? [opts.projectId] : await deps.projects();
    for (const projectId of projects) {
      try {
        const rows = (await deps.records.listComputeJobs(projectId)).filter(isOpen);
        // Re-arm struck-out rows BEFORE the filter, or a manual Refresh could
        // never revive them.
        if (opts.resetStrikes) for (const job of rows) strikes.delete(job.id);
        // Skip rows the last ticks already condemned (3 strikes → `unknown`);
        // a manual Refresh re-arms them above.
        const jobs = rows.filter((job) => (strikes.get(job.id) ?? 0) < STRIKES_BEFORE_UNKNOWN);
        if (jobs.length === 0) continue;
        await reconcile(jobs, touched);
      } catch (err) {
        onError(err);
      }
    }
    for (const job of touched) {
      await deps.records.upsertComputeJob(job).catch((err) => onError(err));
    }
    return touched.length;
  };

  return {
    async tick(opts) {
      if (ticking) return 0; // one reconcile pass at a time
      ticking = true;
      try {
        return await tick(opts);
      } finally {
        ticking = false;
      }
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void this.tick(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
