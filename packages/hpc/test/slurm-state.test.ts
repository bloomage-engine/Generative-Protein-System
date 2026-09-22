import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExitCode, sacctStateToJobState, squeueStateToJobState } from "../src/slurm-state.js";

test("squeue codes map onto the ledger states", () => {
  assert.equal(squeueStateToJobState("PD"), "pending");
  assert.equal(squeueStateToJobState("CF"), "pending");
  assert.equal(squeueStateToJobState("R"), "running");
  assert.equal(squeueStateToJobState("CG"), "running");
  assert.equal(squeueStateToJobState("S"), "running");
});

test("sacct settled codes map, both long and short forms", () => {
  assert.equal(sacctStateToJobState("COMPLETED"), "completed");
  assert.equal(sacctStateToJobState("CD"), "completed");
  assert.equal(sacctStateToJobState("FAILED"), "failed");
  assert.equal(sacctStateToJobState("TIMEOUT"), "failed");
  assert.equal(sacctStateToJobState("CANCELLED"), "cancelled");
  assert.equal(sacctStateToJobState("REVOKED"), "cancelled");
});

test("an unrecognized state answers unknown rather than throwing", () => {
  assert.equal(squeueStateToJobState("WHATEVER"), "unknown");
  assert.equal(sacctStateToJobState(""), "unknown");
  assert.equal(sacctStateToJobState("completed"), "completed"); // case-insensitive
});

test("exit codes parse the slurm <code>:<signal> form", () => {
  assert.equal(parseExitCode("0:0"), 0);
  assert.equal(parseExitCode("1:0"), 1);
  assert.equal(parseExitCode("0:255"), 0);
  assert.equal(parseExitCode("NA"), undefined);
  assert.equal(parseExitCode(""), undefined);
});
