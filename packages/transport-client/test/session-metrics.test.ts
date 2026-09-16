import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@science-studio/record";
import { formatTokens, summarizeSessionRuns } from "../src/session-metrics.js";

function run(over: Partial<Run>): Run {
  return {
    id: "r",
    sessionId: "s1",
    projectId: "p1",
    status: "completed",
    agentId: "main",
    parameters: {},
    input: "q",
    ...over,
  };
}

test("filters to the Session and counts only its Runs", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "b", sessionId: "s1", finishedAt: "2026-01-02T00:00:00.000Z" }),
      run({ id: "x", sessionId: "s2", finishedAt: "2026-01-03T00:00:00.000Z" }),
      run({ id: "a", sessionId: "s1", finishedAt: "2026-01-01T00:00:00.000Z" }),
    ],
    "s1",
  );
  assert.equal(metrics.cumulative.runs, 2);
});

test("sums input/output and derives total when totalTokens is absent", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "a", parameters: { usage: { inputTokens: 100, outputTokens: 20 } } }),
      run({ id: "b", parameters: { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 70 } } }),
    ],
    "s1",
  );
  assert.deepEqual(metrics.cumulative, { input: 150, output: 30, total: 190, runs: 2 });
});

test("latest picks the newest Run by finishedAt and its usage", () => {
  const metrics = summarizeSessionRuns(
    [
      run({
        id: "a",
        finishedAt: "2026-01-01T00:00:00.000Z",
        parameters: { usage: { inputTokens: 5, outputTokens: 1 } },
      }),
      run({
        id: "b",
        finishedAt: "2026-01-02T00:00:00.000Z",
        parameters: { usage: { inputTokens: 900, outputTokens: 40 } },
      }),
    ],
    "s1",
  );
  assert.equal(metrics.latest!.usage!.inputTokens, 900);
});

test("model fields come from the most recent Run that carries them, merged", () => {
  const metrics = summarizeSessionRuns(
    [
      run({
        id: "a",
        finishedAt: "2026-01-01T00:00:00.000Z",
        parameters: { provider: "p", model: "m", contextWindow: 128000 },
      }),
      run({ id: "b", finishedAt: "2026-01-02T00:00:00.000Z" }),
    ],
    "s1",
  );
  assert.deepEqual(metrics.model, { provider: "p", model: "m", contextWindow: 128000 });
});

test("a later Run without model fields does not erase an earlier one", () => {
  const metrics = summarizeSessionRuns(
    [
      run({ id: "a", parameters: { contextWindow: 64000 } }),
      run({ id: "b", parameters: { provider: "p2" } }),
    ],
    "s1",
  );
  assert.deepEqual(metrics.model, { provider: "p2", contextWindow: 64000 });
});

test("malformed usage is ignored, not fatal", () => {
  const metrics = summarizeSessionRuns(
    [run({ id: "a", parameters: { usage: { inputTokens: "nope" } } })],
    "s1",
  );
  assert.deepEqual(metrics.cumulative, { input: 0, output: 0, total: 0, runs: 1 });
  assert.equal(metrics.latest!.usage, undefined);
});

test("a Session with no Runs has empty cumulative and no latest", () => {
  const metrics = summarizeSessionRuns([run({ id: "x", sessionId: "s2" })], "s1");
  assert.equal(metrics.latest, undefined);
  assert.deepEqual(metrics.cumulative, { input: 0, output: 0, total: 0, runs: 0 });
});

test("formatTokens renders exact small numbers and compact large ones", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_300), "12.3k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(128_000), "128k");
  assert.equal(formatTokens(undefined), "—");
});
