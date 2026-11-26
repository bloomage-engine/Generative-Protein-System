import { test } from "node:test";
import assert from "node:assert/strict";
import { isCronTaskPath, parseLogEntries, taskIdFromPath } from "../src/cron.js";

test("the client re-exports the pure task-path predicate", () => {
  assert.equal(isCronTaskPath(".gps/cron/x.md"), true);
  assert.equal(taskIdFromPath(".gps/cron/x.md"), "x");
  assert.equal(isCronTaskPath(".gps/cron/x.log.md"), false);
});

test("the client re-exports the log parser", () => {
  const entries = parseLogEntries(
    "## 2026-09-18T09:00:00.000Z · success\n- session: s1\n\nDone.\n",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, "success");
  assert.equal(entries[0]!.message, "Done.");
});
