import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLogEntry, latestLogEntry, parseLogEntries } from "../src/log.js";

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

test("parseLogEntries returns every section newest first", () => {
  let text = "";
  text = appendLogEntry(text, {
    at: "2026-09-18T09:00:00.000Z",
    status: "success",
    sessionId: "s1",
    runId: "run-1",
    message: "All good.",
  });
  text = appendLogEntry(text, {
    at: "2026-09-19T09:00:00.000Z",
    status: "skipped-busy",
    sessionId: "s1",
  });
  text = appendLogEntry(text, {
    at: "2026-09-20T09:00:00.000Z",
    status: "error",
    message: "Line one\n\nLine two",
  });

  const entries = parseLogEntries(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => [entry.at, entry.status]),
    [
      ["2026-09-20T09:00:00.000Z", "error"],
      ["2026-09-19T09:00:00.000Z", "skipped-busy"],
      ["2026-09-18T09:00:00.000Z", "success"],
    ],
  );
  assert.equal(entries[2]!.runId, "run-1");
  assert.equal(entries[2]!.sessionId, "s1");
  assert.equal(entries[0]!.message, "Line one\n\nLine two");
  assert.equal(entries[1]!.message, undefined);
  assert.equal(latestLogEntry(text)?.at, "2026-09-20T09:00:00.000Z");
});

test("parseLogEntries ignores empty and malformed logs", () => {
  assert.deepEqual(parseLogEntries(""), []);
  assert.deepEqual(parseLogEntries("no sections here\n"), []);
  assert.deepEqual(parseLogEntries("## not-a-date · nope\n\nbody\n"), []);
});
