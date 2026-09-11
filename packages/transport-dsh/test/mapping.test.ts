import { test } from "node:test";
import assert from "node:assert/strict";
import { runStatus, turnEndStatus } from "../src/mapping.js";

test("runStatus maps a turn's terminal reason onto the Run status", () => {
  assert.equal(runStatus(undefined), "error");
  assert.equal(runStatus({ kind: "completed" } as never), "completed");
  assert.equal(runStatus({ kind: "error" } as never), "error");
  assert.equal(runStatus({ kind: "aborted" } as never), "aborted");
});

test("turnEndStatus maps a reason onto the terminal session status", () => {
  assert.equal(turnEndStatus({ kind: "completed" } as never), "idle");
  assert.equal(turnEndStatus({ kind: "aborted" } as never), "idle");
  assert.equal(turnEndStatus({ kind: "error" } as never), "error");
});
