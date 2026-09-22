import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore, type ComputeJob } from "@science-studio/record";
import { createHpcPoller } from "../src/hpc/poller.js";
import { ENDPOINT, fakeSsh } from "./hpc-support.js";

function slurmJob(over: Partial<ComputeJob> = {}): ComputeJob {
  return {
    id: "cjob-aaa-1",
    projectId: "p1",
    endpointId: "cluster-a",
    kind: "slurm",
    remoteJobId: "4242",
    name: "n",
    state: "pending",
    remoteDir: "~/w/.ss-jobs/cjob-aaa-1",
    submittedAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...over,
  };
}

function linuxJob(over: Partial<ComputeJob> = {}): ComputeJob {
  return slurmJob({
    id: "cjob-bbb-1",
    endpointId: "box-1",
    kind: "linux",
    remoteJobId: "424",
    state: "submitted",
    ...over,
  });
}

async function withPoller(
  answers: Parameters<typeof fakeSsh>[0],
  jobs: ComputeJob[],
  fn: (poller: ReturnType<typeof createHpcPoller>, ssh: ReturnType<typeof fakeSsh>, store: ReturnType<typeof createInMemoryRecordStore>) => Promise<void>,
) {
  const ssh = fakeSsh(answers);
  const store = createInMemoryRecordStore();
  await store.createProject({ id: "p1", name: "P", createdAt: "2026-01-01T00:00:00.000Z" });
  for (const job of jobs) await store.upsertComputeJob(job);
  const poller = createHpcPoller({
    records: store,
    projects: async () => ["p1"],
    endpoints: async () => [ENDPOINT, { ...ENDPOINT, id: "box-1", kind: "linux" }],
    ssh,
  });
  await fn(poller, ssh, store);
}

test("a live squeue row updates state once (no churn)", async () => {
  await withPoller([{ match: /squeue -h/, result: { stdout: "4242|R|gpu|node01|None\n" } }], [slurmJob()], async (poller, ssh, store) => {
    assert.equal(await poller.tick(), 1);
    const row = (await store.listComputeJobs("p1"))[0]!;
    assert.equal(row.state, "running");
    assert.equal(row.nodeList, "node01");
    assert.ok(row.startedAt);
    // second tick: nothing changed → no row churn, but ssh still asked.
    assert.equal(await poller.tick(), 0);
    assert.equal(ssh.calls.length, 2);
  });
});

test("a row gone from squeue settles once through sacct", async () => {
  const answers = [
    { match: /squeue -h/, result: { stdout: "" } },
    { match: /sacct -n -P -X/, result: { stdout: "4242|COMPLETED|0:0|2026-09-22T10:00:00|2026-09-22T11:00:00|node01\n" } },
  ];
  await withPoller(answers, [slurmJob({ state: "running" })], async (poller, _ssh, store) => {
    assert.equal(await poller.tick(), 1);
    const row = (await store.listComputeJobs("p1"))[0]!;
    assert.equal(row.state, "completed");
    assert.equal(row.exitCode, 0);
    assert.equal(row.finishedAt, new Date("2026-09-22T11:00:00").toISOString());
    assert.equal(row.startedAt, new Date("2026-09-22T10:00:00").toISOString());
  });
});

test("a settled terminal row is never polled again", async () => {
  const answers = [
    { match: /squeue -h/, result: { stdout: "" } },
    { match: /sacct -n -P -X/, result: { stdout: "4242|FAILED|2:0|N/A|N/A|N/A\n" } },
  ];
  await withPoller(answers, [slurmJob({ state: "running" })], async (poller, ssh, store) => {
    await poller.tick();
    ssh.calls.length = 0;
    assert.equal(await poller.tick(), 0);
    assert.equal(ssh.calls.length, 0);
    const row = (await store.listComputeJobs("p1"))[0]!;
    assert.equal(row.state, "failed");
    assert.equal(row.exitCode, 2);
  });
});

test("three reconcile failures settle the row to unknown and stop polling", async () => {
  await withPoller([{ match: /squeue -h/, result: { code: 255, stderr: "Permission denied" } }], [slurmJob()], async (poller, ssh, store) => {
    await poller.tick();
    await poller.tick();
    await poller.tick();
    const before = ssh.calls.length;
    await poller.tick();
    assert.equal(ssh.calls.length, before, "a struck-out row costs no more SSH");
    const row = (await store.listComputeJobs("p1"))[0]!;
    assert.equal(row.state, "unknown");
    assert.match(row.error ?? "", /Permission denied/);
    // a manual reconcile (Refresh) re-arms it.
    const armed = ssh.calls.length;
    await poller.tick({ resetStrikes: true });
    assert.ok(ssh.calls.length > armed, "a refresh re-arms the probe");
  });
});

test("linux rows reconcile via the exit marker / live pid / gone", async () => {
  await withPoller(
    [
      { match: /if \[ -f/, result: { stdout: "cjob-bbb-1 RC 0\n" } },
    ],
    [linuxJob({ state: "running" })],
    async (poller, _ssh, store) => {
      await poller.tick();
      assert.equal((await store.listComputeJobs("p1"))[0]?.state, "completed");
    },
  );
  await withPoller(
    [{ match: /if \[ -f/, result: { stdout: "cjob-bbb-1 LIVE\n" } }],
    [linuxJob({ state: "submitted" })],
    async (poller, _ssh, store) => {
      await poller.tick();
      assert.equal((await store.listComputeJobs("p1"))[0]?.state, "running");
    },
  );
  await withPoller(
    [{ match: /if \[ -f/, result: { stdout: "cjob-bbb-1 GONE\n" } }],
    [linuxJob({ state: "running" })],
    async (poller, _ssh, store) => {
      await poller.tick();
      await poller.tick();
      await poller.tick();
      const row = (await store.listComputeJobs("p1"))[0]!;
      assert.equal(row.state, "unknown");
      assert.match(row.error ?? "", /gone without/);
    },
  );
});

test("a deleted endpoint strikes the rows that name it", async () => {
  await withPoller([], [slurmJob()], async (poller, _ssh, store) => {
    // no endpoints resolve: the poller's list has cluster-a, so instead point
    // the row at a gone endpoint via the next scenario below.
    const row = (await store.listComputeJobs("p1"))[0]!;
    await store.upsertComputeJob({ ...row, endpointId: "gone" });
    await poller.tick();
    const after = (await store.listComputeJobs("p1"))[0]!;
    assert.match(after.error ?? "", /deleted/);
  });
});
