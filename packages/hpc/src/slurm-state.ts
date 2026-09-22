/**
 * Slurm state → the Compute Job state enum (docs/adr/0024). The pure half of
 * the reconciler: the poller feeds it `squeue`/`sacct` state strings, this maps
 * them onto the ledger's `ComputeJobState`. Unknown codes answer `unknown` —
 * the LAST known state then stays displayed with the reason (the poller owns
 * that decision; this function never throws).
 */
import type { ComputeJobState } from "@science-studio/record";

/** squeue `%T` codes (the live set: pending through completing). */
const SQUEUE_STATES: Record<string, ComputeJobState> = {
  PD: "pending",
  PENDING: "pending",
  CF: "pending",
  CONFIGURING: "pending",
  R: "running",
  RUNNING: "running",
  CG: "running", // completing — still occupies resources
  COMPLETING: "running",
  S: "running", // suspended — still the scheduler's, keep it alive in the panel
  SUSPENDED: "running",
  BF: "pending", // blocked (fed) — waiting, not failed
};

/** sacct `%State` codes — the settled truth, after squeue purges the row. */
const SACCT_STATES: Record<string, ComputeJobState> = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETING: "running",
  SUSPENDED: "running",
  CD: "completed",
  COMPLETED: "completed",
  F: "failed",
  FAILED: "failed",
  TO: "failed",
  TIMEOUT: "failed",
  NF: "failed",
  NODE_FAIL: "failed",
  OOM: "failed",
  OUT_OF_MEMORY: "failed",
  PREEMPTED: "failed",
  CA: "cancelled",
  CANCELLED: "cancelled",
  REVOKE: "cancelled",
  REVOKED: "cancelled",
};

export function squeueStateToJobState(raw: string): ComputeJobState {
  return SQUEUE_STATES[raw.trim().toUpperCase()] ?? "unknown";
}

export function sacctStateToJobState(raw: string): ComputeJobState {
  return SACCT_STATES[raw.trim().toUpperCase()] ?? "unknown";
}

/** sacct `ExitCode` is `<signal|code>:<...>`; the first half is the value. */
export function parseExitCode(raw: string): number | undefined {
  const head = raw.trim().split(":")[0] ?? "";
  if (!/^\d+$/.test(head)) return undefined;
  const code = Number(head);
  return Number.isSafeInteger(code) ? code : undefined;
}
