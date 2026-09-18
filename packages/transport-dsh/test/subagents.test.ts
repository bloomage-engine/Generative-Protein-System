import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry, type SubagentLedgerEntry } from "../src/subagents.js";

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

/** An in-memory store the registry persists into (the seam's test shape). */
class FakeLedgerStore {
  readonly files = new Map<string, SubagentLedgerEntry[]>();
  async listKeys() {
    return [...this.files.keys()];
  }
  async load(key: string) {
    return this.files.get(key) ?? null;
  }
  async save(key: string, entries: readonly SubagentLedgerEntry[]) {
    this.files.set(key, [...entries]);
  }
}

test("a store persists per session key on every mutation", () => {
  const store = new FakeLedgerStore();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => `t${Math.random()}`);
  reg.attachStore(store);
  reg.noteStarted("root-1", "child-1");
  reg.noteDescriptor("child-1", { label: "Literature review", provider: "spawn" });
  reg.noteFinished("child-1", { status: "ok", stopReason: "completed" });
  return reg.flush().then(() => {
    const rows = store.files.get("sess-1")!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "child-1");
    assert.equal(rows[0]!.status, "completed");
    assert.equal(rows[0]!.sessionKey, "sess-1");
    assert.equal(store.files.has("sess-2"), false, "only the owning key is ever written");
  });
});

test("a restored ledger keeps finished runs and settles stale ones to aborted", async () => {
  const store = new FakeLedgerStore();
  store.files.set("sess-1", [
    { id: "old-done", parentHarnessId: "root-old", status: "completed", startedAt: "t0", finishedAt: "t1" },
    { id: "old-run", parentHarnessId: "root-old", status: "running", startedAt: "t2" },
  ]);
  const reg = new SubagentRegistry(() => undefined, () => "now");
  reg.attachStore(store);
  await reg.ready();
  const runs = reg.list("sess-1");
  assert.equal(runs.length, 2);
  assert.equal(runs.find((r) => r.id === "old-done")!.status, "completed");
  const stale = runs.find((r) => r.id === "old-run")!;
  assert.equal(stale.status, "aborted", "a restored running entry is settled");
  assert.equal(stale.finishedAt, "now");
});

test("a finished run without a started notification is recorded from its own parent", () => {
  const store = new FakeLedgerStore();
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t0");
  reg.attachStore(store);
  reg.noteFinished("child-x", { status: "ok", stopReason: "completed", parentSessionId: "root-1" });
  const [run] = reg.list("sess-1");
  assert.ok(run, "a finished run is recorded under its own parent key");
  assert.equal(run.id, "child-x");
  assert.equal(run.status, "completed");
  assert.equal(run.startedAt, "t0", "startedAt is stamped at observation (the wire carries none)");
});

test("a live entry wins over a restored duplicate", async () => {
  const store = new FakeLedgerStore();
  store.files.set("sess-1", [
    { id: "child-1", parentHarnessId: "root-old", status: "completed", startedAt: "t0" },
  ]);
  const reg = new SubagentRegistry((root) => (root === "root-1" ? "sess-1" : undefined), () => "t9");
  reg.attachStore(store);
  reg.noteStarted("root-1", "child-1");
  await reg.ready();
  const [run] = reg.list("sess-1");
  assert.ok(run, "a live entry is listed under the session key");
  assert.equal(run.status, "running", "the live in-memory entry is not clobbered by a restore");
});
