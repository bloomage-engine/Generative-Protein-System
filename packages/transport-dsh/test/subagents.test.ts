import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry } from "../src/subagents.js";
import type { Run, Subagent } from "@science-studio/record";
import type { RecordStoreLike } from "@science-studio/transport";

function registry(resolve: (id: string) => string | undefined) {
  let tick = 0;
  return new SubagentRegistry(resolve, () => `t${tick++}`);
}

test("a started child is running until finished", () => {
  const reg = registry((root) => (root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  const [run] = reg.list("sess-1");
  assert.ok(run?.id?.startsWith("subagent-"), "the panel id is the stable (record) id");
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
  const ids = reg.list("sess-1").map((run) => run.id);
  assert.equal(ids.length, 2, "child and grandchild both resolve to the root session");
  assert.ok(ids.every((id) => id.startsWith("subagent-")));
  assert.deepEqual(reg.list("sess-2"), []);
});

test("entries are scoped to their session", () => {
  const reg = new SubagentRegistry(
    (root) => (root === "root-1" ? "sess-1" : root === "root-2" ? "sess-2" : undefined),
    () => `t${Math.random()}`,
  );
  reg.noteStarted("root-1", "a");
  reg.noteStarted("root-2", "b");
  const inOne = reg.list("sess-1");
  const inTwo = reg.list("sess-2");
  assert.equal(inOne.length, 1);
  assert.equal(inTwo.length, 1);
  assert.equal(inOne[0]!.parentId, "sess-1");
  assert.equal(inTwo[0]!.parentId, "sess-2");
  assert.notEqual(inOne[0]!.id, inTwo[0]!.id, "each session lists its own subagent");
});

test("an unresolvable root is skipped but not destroyed", () => {
  let live = true;
  const reg = registry((root) => (live && root === "root-1" ? "sess-1" : undefined));
  reg.noteStarted("root-1", "child-1");
  assert.equal(reg.list("sess-1").length, 1);
  live = false;
  assert.deepEqual(reg.list("sess-1"), [], "an entry with no resolvable root is not listed");
  live = true;
  const ids = reg.list("sess-1").map((run) => run.id);
  assert.equal(ids.length, 1, "the skip is non-destructive: the entry returns once its root resolves");
  assert.ok(ids[0]!.startsWith("subagent-"));
});

test("two children in one session are listed newest-first", () => {
  const reg = registry(() => "sess-1");
  reg.noteStarted("root-1", "older");
  reg.noteStarted("root-1", "newer");
  const runs = reg.list("sess-1");
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.startedAt, "t1", "newest first");
  assert.equal(runs[1]!.startedAt, "t0");
  assert.notEqual(runs[0]!.id, runs[1]!.id);
});

/** A RecordStoreLike that persists the registry's subagent rows (the seam's test shape). */
class FakeRecordStoreLike implements RecordStoreLike {
  readonly runs: Run[] = [];
  readonly subagents = new Map<string, Subagent>();
  async addRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
  async upsertSubagent(subagent: Subagent): Promise<void> {
    this.subagents.set(subagent.id, { ...subagent });
  }
  async loadSubagent(id: string): Promise<Subagent | null> {
    return this.subagents.get(id) ?? null;
  }
  async listSubagents(parentSessionId: string): Promise<Subagent[]> {
    return [...this.subagents.values()].filter((s) => s.parentSessionId === parentSessionId);
  }
}

test("a store persists the row under the parent session on every mutation", async () => {
  const store = new FakeRecordStoreLike();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t0", store);
  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "Literature review", provider: "spawn" });
  reg.noteFinished("child-1", { status: "ok", stopReason: "completed" });
  await reg.flush();
  const stableId = reg.list("sess-1")[0]!.id;
  assert.ok(stableId.startsWith("subagent-"));
  const row = await store.loadSubagent(stableId);
  assert.ok(row);
  assert.equal(row!.parentSessionId, "sess-1");
  assert.equal(row!.status, "completed");
  assert.equal(row!.label, "Literature review");
  assert.equal((await store.listSubagents("sess-2")).length, 0, "only the owning parent is ever written");
});

test("a restored record keeps finished runs and settles stale ones to aborted", async () => {
  const store = new FakeRecordStoreLike();
  await store.upsertSubagent({ id: "subagent-old-done", parentSessionId: "sess-1", origin: "subagent", status: "completed", startedAt: "t0", finishedAt: "t1" });
  await store.upsertSubagent({ id: "subagent-old-run", parentSessionId: "sess-1", origin: "subagent", status: "running", startedAt: "t2" });
  const reg = new SubagentRegistry(() => undefined, () => "now", store);
  await reg.restore("sess-1");
  const runs = reg.list("sess-1");
  assert.equal(runs.length, 2);
  const done = runs.find((r) => r.id === "subagent-old-done");
  assert.ok(done);
  assert.equal(done!.status, "completed");
  const stale = runs.find((r) => r.id === "subagent-old-run");
  assert.ok(stale);
  assert.equal(stale!.status, "aborted", "a restored running run is settled to aborted");
  assert.equal(stale!.finishedAt, "now");
});

test("a finished run without a started notification is recorded from its own parent", async () => {
  const store = new FakeRecordStoreLike();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t0", store);
  reg.noteFinished("child-x", { status: "ok", stopReason: "completed", parentSessionId: "root-1" });
  await reg.flush();
  const [run] = reg.list("sess-1");
  assert.ok(run, "a finished run is recorded under its own parent session");
  assert.ok(run!.id.startsWith("subagent-"));
  assert.equal(run!.status, "completed");
  assert.equal(run!.startedAt, "t0", "startedAt is stamped at observation (the wire carries none)");
});

test("a live entry is not clobbered by a restore of the same session", async () => {
  const store = new FakeRecordStoreLike();
  await store.upsertSubagent({ id: "subagent-seed", parentSessionId: "sess-1", origin: "subagent", status: "completed", startedAt: "t0" });
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t9", store);
  reg.noteStarted("root-1", "child-1");
  await reg.restore("sess-1");
  const runs = reg.list("sess-1");
  const live = runs.find((r) => r.status === "running");
  assert.ok(live, "the live entry is listed and not clobbered by a restore");
  assert.ok(live!.id.startsWith("subagent-"));
  const restored = runs.find((r) => r.id === "subagent-seed");
  assert.ok(restored, "the restored record row is also listed");
  assert.equal(restored!.status, "completed");
});
