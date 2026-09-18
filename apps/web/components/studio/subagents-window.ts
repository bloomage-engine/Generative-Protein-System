import type { SubagentRun } from "@science-studio/transport";

/** The default recent-window when settings don't specify one. */
export const DEFAULT_SUBAGENT_WINDOW_HOURS = 24;

/**
 * One subagent run is "recent" if it is still running (any age — the user is
 * watching it) OR its most recent activity (the newer of startedAt/finishedAt)
 * falls within `windowMs` of `now`. A boundary row exactly at `windowMs` is
 * included (an inclusive window).
 */
export function isRecent(run: SubagentRun, windowMs: number, now: number): boolean {
  if (run.status === "running") return true;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return false;
  const finished = run.finishedAt !== undefined ? Date.parse(run.finishedAt) : NaN;
  const lastActivity = Number.isNaN(finished) ? started : Math.max(started, finished);
  return now - lastActivity <= windowMs;
}

/** Convert an hours value to a millisecond window, clamped to 1h minimum. */
export function windowMsFromHours(hours: number): number {
  const truncated = Math.max(1, Math.trunc(hours));
  return truncated * 3_600_000;
}
