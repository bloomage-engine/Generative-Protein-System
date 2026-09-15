import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommandText } from "../src/commands.js";

/**
 * The seam-level command rule (docs/adr/0003): every adapter decides what a
 * command MEANS inside its own runtime, but they must all agree on which
 * messages are commands — the rule is what keeps a `/cmd` row out of `Run`
 * persistence everywhere.
 */
test("isCommandText treats any trimmed /-prefixed text as a command", () => {
  assert.equal(isCommandText("/status"), true);
  assert.equal(isCommandText("  /model gpt-5 -s"), true);
  assert.equal(isCommandText("hi"), false);
  assert.equal(isCommandText(""), false);
  assert.equal(isCommandText("use /weather"), false, "inline slash tokens are not standalone commands");
});
