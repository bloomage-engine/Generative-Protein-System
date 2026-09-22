import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTurnUsage, turnUsageOf, type TurnUsageState, type UsageEventLike } from "../src/usage.js";

/**
 * The fold mirrors the harness's own token-meter projection
 * (`@deepseek-ai/dsh-token-meter`): billed usage is the SUM of the disjoint
 * per-step buckets, a repeated (turn, step) sample REPLACES its own
 * contribution, `llm/retry-started` closes that slot so a retried attempt
 * counts, and context occupancy is the newest sample's prompt size
 * (uncached input + cache traffic, no output).
 */

function msg(turn: number, step: number, usage: unknown): UsageEventLike {
  return { type: "assistant/message", data: { turn, step, usage } };
}

function fold(...events: UsageEventLike[]): TurnUsageState | undefined {
  return events.reduce<TurnUsageState | undefined>((state, event) => foldTurnUsage(state, event), undefined);
}

test("multi-step turns sum their disjoint buckets", () => {
  const state = fold(
    msg(1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 500 }),
    { type: "tool/result", data: { turn: 1, step: 1 } },
    msg(1, 2, { inputTokens: 620, outputTokens: 5, cacheReadTokens: 500 }),
  );
  assert.deepEqual(turnUsageOf(state), {
    inputTokens: 720,
    outputTokens: 15,
    cacheReadTokens: 1000,
  });
  // Occupancy is the LAST request's prompt, not the sum: 620 + 500.
  assert.equal(state?.contextTokens, 1120);
});

test("a repeated (turn, step) sample replaces its own contribution", () => {
  const once = fold(msg(1, 1, { inputTokens: 10, outputTokens: 2 }));
  const twice = fold(
    msg(1, 1, { inputTokens: 10, outputTokens: 2 }),
    msg(1, 1, { inputTokens: 10, outputTokens: 2 }),
  );
  assert.deepEqual(turnUsageOf(twice), turnUsageOf(once));
  const replaced = fold(
    msg(1, 1, { inputTokens: 10, outputTokens: 2 }),
    msg(1, 1, { inputTokens: 12, outputTokens: 3 }),
  );
  assert.deepEqual(turnUsageOf(replaced), { inputTokens: 12, outputTokens: 3 });
});

test("llm/retry-started closes the slot so the retried attempt adds", () => {
  // The same step settles twice: the first attempt's sample must survive when
  // a scheduled retry re-runs it, so the retry transition closes the slot.
  const state = fold(
    msg(1, 1, { inputTokens: 90, outputTokens: 4 }),
    { type: "llm/retry-started", data: { turn: 1, step: 1, retry: 1 } },
    msg(1, 1, { inputTokens: 95, outputTokens: 5 }),
  );
  assert.deepEqual(turnUsageOf(state), { inputTokens: 185, outputTokens: 9 });
});

test("an assistant/attempt settles through the usage chunk embedded in its stream", () => {
  const state = fold({
    type: "assistant/attempt",
    data: {
      turn: 1,
      step: 2,
      stream: [
        { type: "text-delta", index: 0, text: "partial" },
        { type: "usage", usage: { inputTokens: 40, outputTokens: 6 } },
        { type: "finish", reason: { kind: "error" } },
      ],
    },
  });
  assert.deepEqual(turnUsageOf(state), { inputTokens: 40, outputTokens: 6 });
  assert.equal(state?.contextTokens, 40);
});

test("a message prefers its usage field over the stream chunk", () => {
  const state = fold({
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 5, outputTokens: 1 },
      stream: [{ type: "usage", usage: { inputTokens: 500, outputTokens: 99 } }],
    },
  });
  assert.deepEqual(turnUsageOf(state), { inputTokens: 5, outputTokens: 1 });
});

test("cache traffic counts toward occupancy but never toward the prompt alone", () => {
  const state = fold(msg(1, 1, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 40, cacheWriteTokens: 7 }));
  assert.equal(state?.contextTokens, 50);
  assert.deepEqual(turnUsageOf(state), {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 40,
    cacheWriteTokens: 7,
  });
});

test("events that report nothing leave the fold untouched", () => {
  assert.equal(fold({ type: "turn/start", data: { turn: 1 } }), undefined);
  assert.equal(fold(msg(1, 1, undefined)), undefined);
  assert.equal(fold(msg(1, 1, { inputTokens: "nope", outputTokens: 2 })), undefined);
  assert.equal(fold(msg(1, 1, { inputTokens: -2, outputTokens: 2 })), undefined);
  // A retry-started with no open state is a no-op, not a crash.
  assert.equal(fold({ type: "llm/retry-started", data: { turn: 1, step: 1 } }), undefined);
});

test("an all-zero fold projects no usage for a turn that never reported any", () => {
  assert.equal(turnUsageOf(undefined), undefined);
});

test("provider totalTokens survives only when EVERY contributing step had it", () => {
  const both = fold(
    msg(1, 1, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
    msg(1, 2, { inputTokens: 12, outputTokens: 3, totalTokens: 15 }),
  );
  assert.deepEqual(turnUsageOf(both), { inputTokens: 22, outputTokens: 5, totalTokens: 27 });
  const partial = fold(
    msg(1, 1, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
    msg(1, 2, { inputTokens: 12, outputTokens: 3 }),
  );
  assert.deepEqual(turnUsageOf(partial), { inputTokens: 22, outputTokens: 5 });
});
