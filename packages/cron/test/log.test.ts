import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLogEntry, latestLogEntry } from "../src/log.js";

test("appending and reading back the latest entry", () => {
  let text = "";
  text = appendLogEntry(text, {
    at: "2026-09-18T09:00:00.000Z",
    status: "success",
    sessionId: "s1",
    message: "All good.",
  });
  text = appendLogEntry(text, {
    at: "2026-09-19T09:00:00.000Z",
    status: "skipped-busy",
    sessionId: "s1",
  });
  assert.equal(latestLogEntry(text)?.status, "skipped-busy");
  assert.equal(latestLogEntry(text)?.at, "2026-09-19T09:00:00.000Z");
  const withMessage = appendLogEntry(text, {
    at: "2026-09-20T09:00:00.000Z",
    status: "success",
    runId: "run-1",
    message: "Line one\n\nLine two",
  });
  const last = latestLogEntry(withMessage);
  assert.equal(last?.runId, "run-1");
  assert.match(last?.message ?? "", /Line two/);
  assert.equal(latestLogEntry(""), null);
});
