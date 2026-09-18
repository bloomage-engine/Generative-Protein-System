import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedule,
  isValidSchedule,
  matchesSchedule,
  parseSchedule,
  presetToExpression,
} from "../src/schedule.js";

test("the grammar accepts the supported subset and rejects everything else", () => {
  for (const ok of ["0 9 * * *", "*/15 * * * *", "0 9 * * 1", "0 0 1,15 * *", "5-10/2 * * * *"]) {
    assert.equal(isValidSchedule(ok), true, `${ok} should be valid`);
  }
  for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 0 * *", "*/0 * * * *", "a * * * *"]) {
    assert.equal(isValidSchedule(bad), false, `${bad} should be invalid`);
  }
});

test("matching requires ALL five fields (AND semantics)", () => {
  const at = new Date(2026, 8, 18, 9, 30, 0); // 2026-09-18 09:30 local
  assert.equal(matchesSchedule("30 9 * * *", at), true);
  assert.equal(matchesSchedule("30 9 18 9 *", at), true);
  assert.equal(matchesSchedule("30 10 * * *", at), false);
  assert.equal(matchesSchedule("31 9 * * *", at), false);
  // Both day-of-month and day-of-week must match (unlike standard cron's OR).
  assert.equal(matchesSchedule("30 9 19 * 5", at), false);
});

test("presets write canonical expressions", () => {
  assert.equal(presetToExpression("hourly"), "0 * * * *");
  assert.equal(presetToExpression("daily", { hour: 9, minute: 30 }), "30 9 * * *");
  assert.equal(presetToExpression("weekly", { hour: 8, minute: 0, weekday: 1 }), "0 8 * * 1");
});

test("describeSchedule names the common shapes and falls back to the expression", () => {
  assert.equal(describeSchedule("0 * * * *"), "Every hour at :00");
  assert.equal(describeSchedule("30 9 * * *"), "Every day at 09:30");
  assert.equal(describeSchedule("0 9 * * 1"), "Every Monday at 09:00");
  assert.equal(describeSchedule("*/15 * * * *"), "*/15 * * * *");
  assert.equal(parseSchedule("0 9 * * *")?.length, 5);
});
