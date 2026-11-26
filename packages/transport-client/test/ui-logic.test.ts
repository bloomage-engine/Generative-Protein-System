import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandDescriptor } from "@gps/transport";
import { slashMenuEnabled } from "../src/slash-menu.js";
import { buildReasoningTrace, type ReasoningTracePart } from "../src/reasoning.js";

function cmd(id: string): CommandDescriptor {
  return { id, label: id, description: `run ${id}`, invocationText: `/${id}` };
}

test("slashMenuEnabled: mount the trigger only for a non-empty catalog on an idle thread", () => {
  assert.equal(slashMenuEnabled(null, false), false, "catalog still loading → no menu");
  assert.equal(slashMenuEnabled([], false), false, "runtime exposes no commands → no menu");
  assert.equal(slashMenuEnabled([cmd("status")], false), true);
  assert.equal(slashMenuEnabled([cmd("status")], true), false, "running turns disable runtime commands");
});

test("buildReasoningTrace: one titled step per reasoning part, in order", () => {
  const parts: ReasoningTracePart[] = [
    { type: "text", text: "hi" },
    { type: "reasoning", text: "think one", unstable_summary: "Step A" },
    { type: "reasoning", text: "think two" },
  ];
  const trace = buildReasoningTrace(parts, undefined);
  assert.deepEqual(trace.steps, [
    { title: "Step A", body: "think one" },
    { title: "Thinking", body: "think two" },
  ]);
  assert.equal(trace.streaming, false);
});

test("buildReasoningTrace: streaming only while the message runs and a reasoning part is live", () => {
  const live: ReasoningTracePart = { type: "reasoning", text: "x", status: { type: "running" } };
  const done: ReasoningTracePart = { type: "reasoning", text: "y", status: { type: "complete" } };

  assert.equal(buildReasoningTrace([live], { type: "running" }).streaming, true);
  assert.equal(buildReasoningTrace([done], { type: "running" }).streaming, false);
  assert.equal(buildReasoningTrace([live], { type: "complete" }).streaming, false);
  assert.equal(buildReasoningTrace([done], undefined).streaming, false);
  assert.equal(buildReasoningTrace([], { type: "running" }).steps.length, 0);
});
