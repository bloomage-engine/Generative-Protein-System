import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRON_DIR,
  cronLogPath,
  cronTaskPath,
  isCronTaskPath,
  parseTaskDoc,
  serializeTaskDoc,
  taskIdFromPath,
  type CronTask,
} from "../src/task-doc.js";

const TASK: CronTask = {
  id: "daily-digest",
  name: "Daily digest",
  schedule: "0 9 * * *",
  enabled: true,
  sessionId: "sess-abc",
  prompt: "Summarize the feeds.",
  createdAt: "2026-09-18T00:00:00.000Z",
};

test("a task document round-trips through serialize/parse", () => {
  const text = serializeTaskDoc(TASK);
  const parsed = parseTaskDoc(TASK.id, text);
  assert.ok("task" in parsed);
  assert.deepEqual(parsed.task, TASK);
});

test("paths are recognized and the log file is never a task", () => {
  assert.equal(CRON_DIR, ".science-studio/cron");
  assert.equal(cronTaskPath("x1"), ".science-studio/cron/x1.md");
  assert.equal(cronLogPath("x1"), ".science-studio/cron/x1.log.md");
  assert.equal(taskIdFromPath(cronTaskPath("x1")), "x1");
  assert.equal(isCronTaskPath(cronTaskPath("x1")), true);
  assert.equal(isCronTaskPath(cronLogPath("x1")), false);
  assert.equal(isCronTaskPath("notes.md"), false);
  assert.equal(taskIdFromPath(".science-studio/cron/sub/x.md"), null);
});

test("parse rejects malformed documents with a reason", () => {
  assert.ok("error" in parseTaskDoc("bad id!", serializeTaskDoc(TASK)));
  assert.ok("error" in parseTaskDoc("x", "no frontmatter"));
  assert.ok("error" in parseTaskDoc("x", "---\nname: \"x\"\nschedule: \"nope\"\n---\nbody"));
  const missingName = "---\nschedule: \"0 9 * * *\"\n---\nbody";
  assert.match((parseTaskDoc("x", missingName) as { error: string }).error, /name/);
});

test("a hand-edited unquoted scalar still parses", () => {
  const text = "---\nname: Daily digest\nschedule: 0 9 * * *\nenabled: true\n---\nDo it.\n";
  const parsed = parseTaskDoc("daily-digest", text);
  assert.ok("task" in parsed);
  assert.equal(parsed.task.name, "Daily digest");
  assert.equal(parsed.task.prompt, "Do it.\n");
});
