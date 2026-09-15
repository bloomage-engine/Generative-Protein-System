import { test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "../src/shared/single-flight.js";

test("shares one in-flight call between overlapping invocations", async () => {
  let calls = 0;
  let release!: (value: number) => void;
  const guarded = singleFlight(() => {
    calls++;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  });
  const first = guarded();
  const second = guarded();
  assert.equal(calls, 1);
  assert.equal(first, second);
  release(42);
  assert.equal(await first, 42);
});

test("starts a new call after the previous one settles", async () => {
  let calls = 0;
  const guarded = singleFlight(async () => ++calls);
  assert.equal(await guarded(), 1);
  assert.equal(await guarded(), 2);
  assert.equal(calls, 2);
});

test("clears the guard when the call rejects", async () => {
  let calls = 0;
  const guarded = singleFlight(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return "ok";
  });
  await assert.rejects(guarded());
  assert.equal(await guarded(), "ok");
  assert.equal(calls, 2);
});
