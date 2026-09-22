/**
 * Per-turn token accounting for the dsh runtime, folded from the harness's
 * durable usage events.
 *
 * The harness reports usage per MODEL CALL: every committed `assistant/message`
 * (and every settled `assistant/attempt`) carries that step's disjoint buckets,
 * where `inputTokens` counts only UNCACHED input — cached prompt traffic rides
 * `cacheReadTokens`/`cacheWriteTokens` (see `TokenUsage` in `@deepseek-ai/dsh-llm`).
 * So a turn's billed usage is the SUM over its events, and the model's context
 * occupancy is the NEWEST sample's prompt size (uncached input + cache traffic,
 * output excluded — what the harness's own token-meter calls the pressure).
 *
 * These are the same rules `@deepseek-ai/dsh-token-meter`'s session projection
 * ships, ported dependency-free:
 * - a repeated `(turn, step)` sample REPLACES its own contribution (a duplicate
 *   delivery must not double-count);
 * - `llm/retry-started` closes that slot, so a retried attempt's usage ADDS to
 *   the failed attempt's instead of overwriting it.
 *
 * Events are matched by NAME and read structurally, like the bridge's
 * `command/*` extension (docs/adr/0011): `llm/retry-started` is a plugin-merged
 * event type this package does not import, and `SessionEventMap` is explicitly
 * merge-extensible.
 */
import type { TokenUsage } from "@deepseek-ai/dsh-llm";

/**
 * The disjoint per-turn buckets — the token-meter's projection shape — plus
 * the bookkeeping that keeps the provider aggregate honest: `totalSum` is the
 * sum of the steps' `totalTokens`, and `totalless` counts the contributing
 * steps that reported none. The projected aggregate exists only while
 * `totalless` is 0, so the field never claims the provider's truth once any
 * counted step omitted it — and a REPLACEMENT can restore it, because the
 * count is maintained per slot. (A provider total counts the cache buckets, so
 * it cannot be re-derived from `input + output` alone.)
 */
interface Buckets {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalSum: number;
  totalless: number;
  /** True once at least one sample has been folded. */
  reported: boolean;
}

/** The fold state for one Session's current turn. */
export interface TurnUsageState {
  totals: Buckets;
  /** The newest sample's buckets keyed by `(turn, step)` — the replacement slot. */
  last: { turn: number; step: number; buckets: Buckets } | null;
  /** The newest sample's prompt size (uncached input + cache traffic): what occupies the context window. */
  contextTokens?: number;
}

/** The structural view of a session event the fold reads (matched by name). */
export interface UsageEventLike {
  type: string;
  data: unknown;
}

const zeroBuckets = (): Buckets => ({
  uncachedInput: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalSum: 0,
  totalless: 0,
  reported: false,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** A token count the fold may accumulate: a finite, non-negative number. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A wire `TokenUsage` read defensively: both required counters must count. */
function sampleOf(value: unknown): TokenUsage | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const inputTokens = count(raw.inputTokens);
  const outputTokens = count(raw.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const totalTokens = count(raw.totalTokens);
  const cacheReadTokens = count(raw.cacheReadTokens);
  const cacheWriteTokens = count(raw.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/** The usage ONE embedded stream reports for its attempt: its LAST usage chunk. */
function sampleFromStream(stream: unknown): TokenUsage | null {
  if (!Array.isArray(stream)) return null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = asRecord(stream[i]);
    if (chunk?.type === "usage") {
      const sample = sampleOf(chunk.usage);
      if (sample) return sample;
    }
  }
  return null;
}

/** The usage ONE event reports: a settlement's own field first, its stream else. */
function sampleOfEvent(type: string, data: Record<string, unknown>): TokenUsage | null {
  if (type === "assistant/message") return sampleOf(data.usage) ?? sampleFromStream(data.stream);
  return sampleFromStream(data.stream);
}

function bucketsOf(usage: TokenUsage): Buckets {
  return {
    uncachedInput: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    totalSum: usage.totalTokens ?? 0,
    totalless: usage.totalTokens === undefined ? 1 : 0,
    reported: true,
  };
}

function bucketsEqual(left: Buckets, right: Buckets): boolean {
  return (
    left.uncachedInput === right.uncachedInput &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.totalSum === right.totalSum &&
    left.totalless === right.totalless
  );
}

/** `totals - previous + next`: the token-meter's replace-or-add fold step. */
function addReplacing(totals: Buckets, previous: Buckets | undefined, next: Buckets): Buckets {
  return {
    uncachedInput: totals.uncachedInput - (previous?.uncachedInput ?? 0) + next.uncachedInput,
    output: totals.output - (previous?.output ?? 0) + next.output,
    cacheRead: totals.cacheRead - (previous?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: totals.cacheWrite - (previous?.cacheWrite ?? 0) + next.cacheWrite,
    totalSum: totals.totalSum - (previous?.totalSum ?? 0) + next.totalSum,
    totalless: totals.totalless - (previous ? previous.totalless : 0) + next.totalless,
    reported: true,
  };
}

/**
 * Fold one session event into the turn's usage state. Pure and total: an
 * irrelevant or malformed event returns the state unchanged, never throws.
 */
export function foldTurnUsage(
  state: TurnUsageState | undefined,
  event: UsageEventLike,
): TurnUsageState | undefined {
  const data = asRecord(event.data);
  if (!data) return state;

  if (event.type === "llm/retry-started") {
    const turn = count(data.turn);
    const step = count(data.step);
    // Close the replacement slot only for the step the retry re-runs, so the
    // retried attempt ADDS to the failed one (the token-meter's rule).
    if (turn === undefined || step === undefined) return state;
    return state && state.last && state.last.turn === turn && state.last.step === step
      ? { ...state, last: null }
      : state;
  }

  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;
  const usage = sampleOfEvent(event.type, data);
  if (!usage) return state;

  const buckets = bucketsOf(usage);
  const turn = count(data.turn);
  const step = count(data.step);
  const keyed = turn !== undefined && step !== undefined;
  const previous =
    state?.last && keyed && state.last.turn === turn && state.last.step === step
      ? state.last.buckets
      : undefined;
  if (previous && bucketsEqual(previous, buckets)) return state;

  return {
    totals: addReplacing(state?.totals ?? zeroBuckets(), previous, buckets),
    last: keyed ? { turn: turn!, step: step!, buckets } : null,
    contextTokens: buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite,
  };
}

/** The folded turn as a `TokenUsage` for `Run.parameters`, or absent when nothing reported. */
export function turnUsageOf(state: TurnUsageState | undefined): TokenUsage | undefined {
  if (!state || !state.totals.reported) return undefined;
  const { uncachedInput, output, cacheRead, cacheWrite, totalSum, totalless } = state.totals;
  return {
    inputTokens: uncachedInput,
    outputTokens: output,
    ...(totalless === 0 && totalSum > 0 ? { totalTokens: totalSum } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
