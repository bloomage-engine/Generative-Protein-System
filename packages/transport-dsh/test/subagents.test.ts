import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry } from "../src/subagents.js";

function registry(resolve: (id: string) => string | undefined) {
  let tick = 0;
  return new SubagentRegistry(resolve, () => `t${tick++}`);
}

test("a started child is running until finished", () => {
  const reg = registry((root) => (root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  const [run] = reg.list("sess-1");
  assert.equal(run?.id, "child-1");
  assert.equal(run?.parentId, "sess-1");
  assert.equal(run?.status, "running");
  assert.equal(run?.startedAt, "t0");
  assert.equal(run?.finishedAt, undefined);

  reg.noteFinished("child-1", { provider: "spawn", status: "ok", stopReason: "completed" });
  const [done] = reg.list("sess-1");
  assert.equal(done?.status, "completed");
  assert.equal(done?.stopReason, "completed");
  assert.equal(done?.provider, "spawn");
  assert.equal(done?.finishedAt, "t1");
});

test("a descriptor enriches the entry with a label", () => {
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "Literature review", provider: "fork" });
  const [run] = reg.list("sess-1");
  assert.equal(run?.label, "Literature review");
  assert.equal(run?.provider, "fork");
});

test("stop reasons map onto the Run status vocabulary", () => {
  const cases: Array<[string, "ok" | "error", string]> = [
    ["completed", "ok", "completed"],
    ["aborted", "ok", "aborted"],
    ["error", "ok", "error"],
    ["max-tokens", "ok", "completed"],
    ["refusal", "ok", "completed"],
  ];
  for (const [stopReason, status, expected] of cases) {
    const reg = registry(() => "sess-1");
    reg.noteStarted("root-1", "child-1");
    reg.noteFinished("child-1", { status, stopReason });
    assert.equal(reg.list("sess-1")[0]?.status, expected, `stopReason ${stopReason}`);
  }
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "child-1");
  reg.noteFinished("child-1", { status: "error" });
  assert.equal(reg.list("sess-1")[0]?.status, "error", "an error status with no reason is an error");
});

test("a grandchild walks its lineage to the root session", () => {
  const reg = registry((root) => (root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  reg.noteStarted("child-1", "grandchild-1");
  assert.deepEqual(
    reg.list("sess-1").map((run) => run.id).sort(),
    ["child-1", "grandchild-1"],
  );
  assert.deepEqual(reg.list("sess-2"), []);
});

test("entries are scoped to their session and newest-first", () => {
  const reg = new SubagentRegistry(
    (root) => (root === "root-1" ? "sess-1" : root === "root-2" ? "sess-2" : undefined),
    () => `t${Math.random()}`,
  );
  reg.noteStarted("root-1", "a");
  reg.noteStarted("root-2", "b");
  assert.deepEqual(reg.list("sess-1").map((r) => r.id), ["a"]);
  assert.deepEqual(reg.list("sess-2").map((r) => r.id), ["b"]);
});

test("an unresolvable root is skipped but not destroyed", () => {
  let live = true;
  const reg = registry((root) => (live && root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  assert.equal(reg.list("sess-1").length, 1);
  live = false;
  assert.deepEqual(reg.list("sess-1"), [], "an entry with no resolvable root is not listed");
  live = true;
  assert.deepEqual(
    reg.list("sess-1").map((run) => run.id),
    ["child-1"],
    "the skip is non-destructive: the entry returns once its root resolves",
  );
});

test("two children in one session are listed newest-first", () => {
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "older");
  reg.noteStarted("root-1", "newer");
  assert.deepEqual(
    reg.list("sess-1").map((run) => run.id),
    ["newer", "older"],
  );
});
