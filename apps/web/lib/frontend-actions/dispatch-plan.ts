/**
 * The frontend bridge's dispatch decision, as a pure function.
 *
 * The bridge observes every completed tool call that has a registered frontend
 * action and must tell two cases apart:
 *
 * - a call that completes DURING a live run is an instruction to apply now;
 * - a call already in the thread when the run starts is HISTORY, and must be
 *   consumed WITHOUT applying — otherwise the first run after a page load
 *   replays the whole conversation's instructions onto whatever viewer is open
 *   (a freshly reopened structure, which then stacks every old highlight and
 *   measurement).
 *
 * Keeping this decision here makes it testable without mounting React.
 */

/** One completed tool call: `[toolCallId, toolName, result]`. */
export type CompletedToolCall = [toolCallId: string, toolName: string, result: unknown];

export interface DispatchPlan {
  /** Calls to execute now (live, not yet dispatched). */
  apply: CompletedToolCall[];
  /** Calls to mark handled WITHOUT executing (history off a live run). */
  consume: CompletedToolCall[];
}

/**
 * Split the completed calls into "apply now" and "consume silently", skipping
 * ones already dispatched. `live` is true while a run is in flight (and for the
 * single observation where it just ended, so a result landing on the settle
 * tick is still applied).
 */
export function planDispatch(
  completed: readonly CompletedToolCall[],
  dispatched: ReadonlySet<string>,
  live: boolean,
): DispatchPlan {
  const apply: CompletedToolCall[] = [];
  const consume: CompletedToolCall[] = [];
  for (const call of completed) {
    if (dispatched.has(call[0])) continue;
    (live ? apply : consume).push(call);
  }
  return { apply, consume };
}
