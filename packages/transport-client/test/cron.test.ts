import { test } from "node:test";
import assert from "node:assert/strict";
import { isCronTaskPath, taskIdFromPath } from "../src/cron.js";

test("the client re-exports the pure task-path predicate", () => {
  assert.equal(isCronTaskPath(".science-studio/cron/x.md"), true);
  assert.equal(taskIdFromPath(".science-studio/cron/x.md"), "x");
  assert.equal(isCronTaskPath(".science-studio/cron/x.log.md"), false);
});
