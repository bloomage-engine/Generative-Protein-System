/**
 * The frontend bridge's dispatch decision (`planDispatch`): a completed tool
 * call is APPLIED only while a run is live; history seen off a run is CONSUMED
 * without executing, so reopening a structure does not replay the whole
 * conversation's molql/measurements onto it.
 *
 * Pure — no DOM, no React, no web server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDispatch } from "../lib/frontend-actions/dispatch-plan.ts";

const call = (id, name = "molql", result = {}) => [id, name, result];

test("live: applies unseen completed calls and skips already-dispatched ones", () => {
  const plan = planDispatch([call("a"), call("b")], new Set(["a"]), true);
  assert.deepEqual(plan.apply, [call("b")]);
  assert.deepEqual(plan.consume, []);
});

test("history off a run is consumed, never applied", () => {
  const plan = planDispatch([call("a"), call("b")], new Set(), false);
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.consume, [call("a"), call("b")]);
});

test("dispatched calls are ignored in both modes", () => {
  const dispatched = new Set(["a", "b"]);
  assert.deepEqual(planDispatch([call("a"), call("b")], dispatched, true), {
    apply: [],
    consume: [],
  });
  assert.deepEqual(planDispatch([call("a"), call("b")], dispatched, false), {
    apply: [],
    consume: [],
  });
});

test("the same toolCallId is not both applied and consumed", () => {
  const plan = planDispatch([call("a"), call("b")], new Set(), true);
  const ids = [...plan.apply, ...plan.consume].map((c) => c[0]);
  assert.deepEqual(ids, ["a", "b"]);
});
