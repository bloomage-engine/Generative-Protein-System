/**
 * The ledger's state-machine rule (docs/adr/0024): which Compute Job States
 * are still OPEN. It lives HERE, not in `packages/record`, because the rule
 * needs one home and this package is the only place that owns the ledger
 * vocabulary AND is browser-safe — `@science-studio/record` pulls
 * `node:fs/promises` into the bundle the moment a value (not a type) crosses
 * the line, and the web Jobs panel imports exactly this.
 */
import type { ComputeJobState } from "@science-studio/record";

/** The non-terminal states: a row in one of these is what the poller wakes for. */
export const NON_TERMINAL_COMPUTE_JOB_STATES: readonly ComputeJobState[] = [
  "submitted",
  "pending",
  "running",
];

/**
 * Whether a Compute Job is still OPEN: `unknown` counts as open (the poller
 * re-arms it on a manual Refresh), so the panel pins it, the cap counts it,
 * cancel offers it.
 */
export function isOpenComputeJobState(state: ComputeJobState): boolean {
  return state === "unknown" || NON_TERMINAL_COMPUTE_JOB_STATES.includes(state);
}
