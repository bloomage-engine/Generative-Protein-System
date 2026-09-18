import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBAGENT_WINDOW_HOURS,
  isRecent,
  windowMsFromHours,
} from "../components/studio/subagents-window.ts";

const H = 3_600_000;

test("a currently running row is always recent", () => {
  const run = {
    id: "x",
    parentId: "s",
    status: "running",
    startedAt: new Date(Date.now() - 10 * 24 * H).toISOString(),
  };
  assert.equal(isRecent(run, 24 * H, Date.now()), true, "a 10-day-old still-running row is recent");
});

test("a finished row is recent when its last activity falls within the window", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const fresh = {
    id: "x",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 2 * H).toISOString(),
    finishedAt: new Date(now - 1 * H).toISOString(),
  };
  const stale = {
    id: "y",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 72 * H).toISOString(),
    finishedAt: new Date(now - 71 * H).toISOString(),
  };
  assert.equal(isRecent(fresh, 24 * H, now), true, "a 1-hour-ago completed row is recent within 24h");
  assert.equal(isRecent(stale, 24 * H, now), false, "a 71-hour-ago completed row is outside the 24h window");
});

test("the boundary (exactly windowMs ago) is included", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const at = {
    id: "x",
    parentId: "s",
    status: "completed",
    startedAt: new Date(now - 24 * H).toISOString(),
    finishedAt: new Date(now - 24 * H).toISOString(),
  };
  assert.equal(isRecent(at, 24 * H, now), true, "a row exactly 24h ago is recent (inclusive boundary)");
});

test("a still-running row is recent regardless of age, even past the window", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const mid = {
    id: "x",
    parentId: "s",
    status: "running",
    startedAt: new Date(now - 30 * H).toISOString(),
    // no finishedAt
  };
  assert.equal(isRecent(mid, 24 * H, now), true, "still running beats the time check");
});

test("a non-running row with no finishedAt uses startedAt as the last activity", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const fresh = {
    id: "x",
    parentId: "s",
    status: "aborted",
    startedAt: new Date(now - 2 * H).toISOString(),
    // no finishedAt
  };
  const stale = {
    id: "y",
    parentId: "s",
    status: "aborted",
    startedAt: new Date(now - 30 * H).toISOString(),
    // no finishedAt
  };
  assert.equal(isRecent(fresh, 24 * H, now), true, "a 2-hour-ago aborted row without finishedAt is recent");
  assert.equal(isRecent(stale, 24 * H, now), false, "a 30-hour-ago aborted row without finishedAt is stale");
});

test("windowMsFromHours truncates fractional hours and floors to a 1h minimum", () => {
  assert.equal(windowMsFromHours(24), 24 * H);
  assert.equal(windowMsFromHours(0), 1 * H, "clamps to a minimum of 1h");
  assert.equal(windowMsFromHours(2.7), 2 * H, "truncates fractional hours");
});

test("the default window is 24 hours", () => {
  assert.equal(DEFAULT_SUBAGENT_WINDOW_HOURS, 24);
});
