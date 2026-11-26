import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryRecordStore,
  createJsonlRecordStore,
  type Project,
  type RecordStore,
  type Run,
  type Session,
} from "../src/index.js";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Metabolism",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  projectId: "p1",
  agentId: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  sessionId: "s1",
  projectId: "p1",
  status: "completed",
  agentId: "main",
  parameters: {},
  input: "hi",
  output: "hello",
  ...over,
});

/** The behaviour contract both implementations must share. */
async function sharedContract(store: RecordStore): Promise<void> {
  await store.createProject(project());
  await store.createProject(project({ id: "p2", name: "Other" }));
  assert.deepEqual(
    (await store.listProjects()).map((p) => p.id),
    ["p1", "p2"],
  );

  await store.archiveProject("p2", "2026-02-01T00:00:00.000Z");
  assert.deepEqual(
    (await store.listProjects()).map((p) => p.id),
    ["p1"],
  );
  assert.deepEqual(
    (await store.listProjects({ includeArchived: true })).map((p) => p.id),
    ["p1", "p2"],
  );
  assert.equal((await store.getProject("p2"))?.archivedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(await store.getProject("missing"), null);

  await store.addSession(session());
  await store.addSession(session({ id: "s2", agentId: "other" }));
  await store.addSession(session({ id: "s3", projectId: "p2" }));
  assert.deepEqual(
    (await store.listSessions("p1")).map((s) => s.id),
    ["s1", "s2"],
  );
  assert.deepEqual(
    (await store.listSessions("p2")).map((s) => s.id),
    ["s3"],
  );
  assert.equal((await store.getSession("s1"))?.agentId, "main");
  assert.equal(await store.getSession("missing"), null);

  await store.addRun(run());
  await store.addRun(run({ id: "r2", sessionId: "s2" }));
  await store.addRun(run({ id: "r3", sessionId: "s3", projectId: "p2" }));
  // A project rollup spans all of that project's Sessions.
  assert.deepEqual(
    (await store.listRuns("p1")).map((r) => r.id),
    ["r1", "r2"],
  );
  assert.deepEqual(
    (await store.listRuns("p2")).map((r) => r.id),
    ["r3"],
  );

  // Rows are copies: mutating what we read back never reaches the store.
  const fetched = (await store.listProjects())[0]!;
  fetched.name = "mutated";
  assert.equal((await store.getProject("p1"))?.name, "Metabolism");

  // Rename is a field update; the id (and so a Project's directory) is stable.
  await store.updateProject("p1", { name: "Renamed" });
  assert.equal((await store.getProject("p1"))?.name, "Renamed");

  await store.updateSession("s1", { title: "First", updatedAt: "2026-03-01T00:00:00.000Z" });
  const renamed = await store.getSession("s1");
  assert.equal(renamed?.title, "First");
  assert.equal(renamed?.updatedAt, "2026-03-01T00:00:00.000Z");

  // Archive is reversible and hides from the default listing.
  await store.archiveSession("s2", "2026-03-02T00:00:00.000Z");
  assert.deepEqual(
    (await store.listSessions("p1")).map((s) => s.id),
    ["s1"],
  );
  assert.deepEqual(
    (await store.listSessions("p1", { includeArchived: true })).map((s) => s.id),
    ["s1", "s2"],
  );
  await store.unarchiveSession("s2");
  assert.equal((await store.getSession("s2"))?.archivedAt, undefined);
  await store.unarchiveProject("p2");
  assert.equal((await store.getProject("p2"))?.archivedAt, undefined);

  // Delete cascades: a Session takes its Runs; a Project takes Sessions and Runs.
  await store.deleteSession("s2"); // s2 owns r2
  assert.equal(await store.getSession("s2"), null);
  assert.deepEqual(
    (await store.listRuns("p1")).map((r) => r.id),
    ["r1"],
  );
  await store.deleteProject("p1");
  assert.equal(await store.getProject("p1"), null);
  assert.deepEqual(await store.listSessions("p1"), []);
  assert.deepEqual(await store.listRuns("p1"), []);
  assert.equal((await store.getProject("p2"))?.name, "Other", "p2 is untouched");
}

test("in-memory store satisfies the RecordStore contract", async () => {
  await sharedContract(createInMemoryRecordStore());
});

test("jsonl store satisfies the RecordStore contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  try {
    await sharedContract(await createJsonlRecordStore(join(dir, "record.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl store restores projects, sessions and runs after a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  const path = join(dir, "record.jsonl");
  try {
    const first = await createJsonlRecordStore(path);
    await first.createProject(project());
    await first.addSession(session());
    await first.addRun(run());

    const reopened = await createJsonlRecordStore(path);
    assert.deepEqual(
      (await reopened.listProjects()).map((p) => p.id),
      ["p1"],
    );
    assert.deepEqual(
      (await reopened.listSessions("p1")).map((s) => s.id),
      ["s1"],
    );
    assert.deepEqual(
      (await reopened.listRuns("p1")).map((r) => r.id),
      ["r1"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl store drops deleted rows across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  const path = join(dir, "record.jsonl");
  try {
    const first = await createJsonlRecordStore(path);
    await first.createProject(project());
    await first.createProject(project({ id: "p2", name: "Other" }));
    await first.addSession(session());
    await first.addRun(run());
    await first.deleteSession("s1");
    await first.deleteProject("p1");

    const reopened = await createJsonlRecordStore(path);
    assert.deepEqual(
      (await reopened.listProjects()).map((p) => p.id),
      ["p2"],
      "the deleted Project stays gone",
    );
    assert.equal(await reopened.getSession("s1"), null, "the cascaded Session stays gone");
    assert.deepEqual(await reopened.listRuns("p1"), [], "the cascaded Run stays gone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jsonl store survives a torn final line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gps-record-"));
  const path = join(dir, "record.jsonl");
  try {
    const first = await createJsonlRecordStore(path);
    await first.createProject(project());
    await first.addRun(run());
    // Simulate a crash mid-append.
    await appendFile(path, '{"t":"run","v":{"id":"r2"', "utf8");

    const reopened = await createJsonlRecordStore(path);
    assert.deepEqual(
      (await reopened.listProjects()).map((p) => p.id),
      ["p1"],
    );
    assert.deepEqual(
      (await reopened.listRuns("p1")).map((r) => r.id),
      ["r1"],
    );
    // Compaction healed the log: a clean reopen reads the same state.
    const third = await createJsonlRecordStore(path);
    assert.deepEqual(
      (await third.listRuns("p1")).map((r) => r.id),
      ["r1"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
