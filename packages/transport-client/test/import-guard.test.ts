import { test } from "node:test";
import assert from "node:assert/strict";
import { canImportThread, type ThreadBusyState } from "../src/session-sync.js";

function busy(over: Partial<ThreadBusyState> = {}): ThreadBusyState {
  return { isRunning: false, isLoading: false, messageCount: 0, ...over };
}

test("a local run (running or loading) blocks every import — the run channel is the sole writer", () => {
  assert.equal(canImportThread(busy({ isRunning: true }), false), false);
  assert.equal(canImportThread(busy({ isRunning: true }), true), false);
  assert.equal(canImportThread(busy({ isLoading: true }), false), false);
  assert.equal(canImportThread(busy({ isLoading: true }), true), false);
});

test("the probe requires an EMPTY thread: an older in-flight snapshot must not clobber a newer watch push", () => {
  assert.equal(canImportThread(busy(), true), true);
  assert.equal(canImportThread(busy({ messageCount: 1 }), true), false);
});

test("the watch adopts on a non-empty thread (whole-replace converges)", () => {
  assert.equal(canImportThread(busy({ messageCount: 5 }), false), true);
});
