import { test } from "node:test";
import assert from "node:assert/strict";
import { watchReconnect } from "../src/watch-loop.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("reconnects are paced: never more than one in-flight attempt, attempts spaced by retryDelayMs", async () => {
  const retryDelayMs = 5;
  let stop = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let attempts = 0;
  const startedAt: number[] = [];

  const connect = async (): Promise<void> => {
    attempts += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    startedAt.push(Date.now());
    // Simulate a dropped/refused connection: the attempt fails fast.
    await sleep(1);
    inFlight -= 1;
  };

  const handle = watchReconnect({ connect, isClosed: () => stop, retryDelayMs });
  await sleep(150);

  stop = true;
  handle.cancel();
  await sleep(20);

  assert.equal(
    maxInFlight,
    1,
    `reconnect attempts must never overlap (saw ${maxInFlight} concurrent attempts after ${attempts} attempts)`,
  );
  for (let i = 1; i < startedAt.length; i++) {
    const gap = startedAt[i] - startedAt[i - 1];
    assert.ok(
      gap >= retryDelayMs,
      `attempt ${i} started only ${gap}ms after the previous one (expected >= ${retryDelayMs}ms backoff)`,
    );
  }
});

test("cancel() stops scheduling further attempts", async () => {
  let attempts = 0;
  const connect = async (): Promise<void> => {
    attempts += 1;
    await sleep(1);
  };

  const handle = watchReconnect({ connect, isClosed: () => false, retryDelayMs: 5 });
  await sleep(30);
  handle.cancel();
  await sleep(10);
  const atCancel = attempts;
  await sleep(50);
  assert.equal(attempts, atCancel, "no further attempts may run after cancel()");
});
