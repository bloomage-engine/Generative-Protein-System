"use client";

/**
 * Session metrics for the status bar: a PURE summarizer over the Session's
 * persisted Runs (the record is the source of truth) plus token formatting.
 * React-free so it is unit-testable directly; the fetch hook lives in
 * `use-session-metrics.ts`.
 *
 * `Run.parameters` is opaque at the seam, so every field is read structurally
 * and a malformed/missing value degrades to "absent" rather than throwing.
 * openclaw records neither `provider`/`model` nor `usage`, so its Sessions
 * summarize to zero usage and no model — the UI renders that as `—`.
 */
import type { Run, RunStatus } from "@gps/record";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface SessionMetrics {
  /** The model the latest Run that disclosed one ran on. */
  model?: { provider?: string; model?: string; contextWindow?: number };
  /** The newest Run's usage and status. */
  latest?: { usage?: TokenUsage; status?: RunStatus; at?: string };
  /**
   * The newest Run's context-window occupancy: the LAST step's prompt size
   * (uncached input + cache traffic). This is the "how full is the window"
   * number — distinct from `latest.usage.inputTokens`, the summed billed input
   * over a turn's whole agent loop. Falls back to the newest usage's prompt
   * when a Run predates the recorded field.
   */
  contextTokens?: number;
  cumulative: { input: number; output: number; total: number; runs: number };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalNumber(raw: Record<string, unknown>, key: string): number | undefined {
  return isFiniteNumber(raw[key]) ? raw[key] : undefined;
}

/** `unknown` → a validated `TokenUsage`, or `undefined` when it is not one. */
function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNumber(raw.inputTokens) || !isFiniteNumber(raw.outputTokens)) return undefined;
  const totalTokens = optionalNumber(raw, "totalTokens");
  const cacheReadTokens = optionalNumber(raw, "cacheReadTokens");
  const cacheWriteTokens = optionalNumber(raw, "cacheWriteTokens");
  const reasoningTokens = optionalNumber(raw, "reasoningTokens");
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/** A run's total tokens: the provider aggregate when given, else the full billed prompt plus output. */
export function runTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? promptTokens(usage) + usage.outputTokens;
}

/**
 * The prompt side of one usage record: uncached input PLUS cache traffic.
 * The counts are disjoint (`TokenUsage` in the dsh contract), so a bare
 * `inputTokens` is not what the model request actually held or billed.
 */
export function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * Aggregate one Session's Runs: filter to the Session, order by end time (then
 * insertion), sum usage across all of them, and read the model route from the
 * most recent Run that disclosed it. Never throws.
 */
export function summarizeSessionRuns(runs: Run[], sessionId: string): SessionMetrics {
  const scoped = runs
    .map((run, index) => ({ run, index }))
    .filter((entry) => entry.run.sessionId === sessionId)
    .sort((a, b) => {
      const at = a.run.finishedAt ?? a.run.startedAt;
      const bt = b.run.finishedAt ?? b.run.startedAt;
      if (at && bt && at !== bt) return at < bt ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.run);

  const cumulative = { input: 0, output: 0, total: 0, runs: scoped.length };
  let model: SessionMetrics["model"] | undefined;
  let contextTokens: number | undefined;

  for (const run of scoped) {
    const usage = parseUsage(run.parameters?.usage);
    if (usage) {
      // "Input" is the billed prompt side (uncached + cache traffic), so
      // in + out reconciles with the total whenever no provider aggregate
      // diverges.
      cumulative.input += promptTokens(usage);
      cumulative.output += usage.outputTokens;
      cumulative.total += runTotal(usage);
    }
    const provider = typeof run.parameters?.provider === "string" ? run.parameters.provider : undefined;
    const modelId = typeof run.parameters?.model === "string" ? run.parameters.model : undefined;
    const contextWindow = optionalNumber(run.parameters ?? {}, "contextWindow");
    if (provider !== undefined || modelId !== undefined || contextWindow !== undefined) {
      model = {
        ...model,
        ...(provider !== undefined ? { provider } : {}),
        ...(modelId !== undefined ? { model: modelId } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    }
    // Context occupancy: the Run's own last-step figure when the adapter
    // recorded it (a Run's `usage` is the WHOLE turn's summed tally — its
    // prompt side is not the window's current fill). A Run without it is a
    // pre-fix record whose `usage` WAS the last step, so its prompt side is
    // the honest occupancy number.
    const disclosed = optionalNumber(run.parameters ?? {}, "contextTokens");
    if (disclosed !== undefined) contextTokens = disclosed;
    else if (usage) contextTokens = promptTokens(usage);
  }

  const latest = scoped.at(-1);
  const latestUsage = latest ? parseUsage(latest.parameters?.usage) : undefined;
  return {
    ...(model ? { model } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(latest
      ? {
          latest: {
            ...(latestUsage ? { usage: latestUsage } : {}),
            status: latest.status,
            ...(latest.finishedAt ?? latest.startedAt
              ? { at: (latest.finishedAt ?? latest.startedAt)! }
              : {}),
          },
        }
      : {}),
    cumulative,
  };
}

/** `12300` → `12.3k`; `1200000` → `1.2M`; `undefined` → `—`. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
