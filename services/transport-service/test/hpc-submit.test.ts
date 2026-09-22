import { test } from "node:test";
import assert from "node:assert/strict";
import type { HpcEndpointSettings } from "@science-studio/transport";
import type { ComputeJob, RecordStore } from "@science-studio/record";
import { createInMemoryRecordStore } from "@science-studio/record";
import { jobPaths } from "@science-studio/hpc";
import {
  buildSbatchScript,
  HpcError,
  parseSubmitBody,
  resolveWorkDir,
  submitJob,
} from "../src/hpc/submit.js";
import { ENDPOINT, LINUX_ENDPOINT, fakeSsh } from "./hpc-support.js";

function records(): RecordStore {
  return createInMemoryRecordStore();
}

test("parseSubmitBody validates the shape", () => {
  assert.throws(() => parseSubmitBody({}), (err: unknown) => (err as HpcError).status === 400);
  assert.throws(() => parseSubmitBody({ name: "x" }), /script \(slurm\) or command/);
  assert.throws(
    () => parseSubmitBody({ name: "x", script: "s", partition: "gpu; rm -rf" }),
    /partition/,
  );
  assert.throws(() => parseSubmitBody({ name: "x", script: "s", mem: "lots" }), /mem/);
  assert.throws(() => parseSubmitBody({ name: "x", script: "s", nodes: "4" }), /nodes/);
  const input = parseSubmitBody({ name: " md ", script: "s", nodes: 4, time: "2:00:00" });
  assert.equal(input.name, "md");
  assert.equal(input.nodes, 4);
  // command is the linux spelling of the same slot
  assert.equal(parseSubmitBody({ name: "x", command: "echo hi" }).command, "echo hi");
});

test("the sbatch header is prepended with defaults applied, caller last", () => {
  const input = parseSubmitBody({ name: "run", script: "#!/bin/bash\necho hi\n" });
  const paths = jobPaths("~/science-studio/p1", "cjob-x");
  const script = buildSbatchScript(input, ENDPOINT, { partition: "a800" }, paths, "cjob-x");
  const header = script.split("\n").slice(0, 6).join("\n");
  assert.match(header, /#SBATCH --job-name=cjob-x/);
  assert.match(header, /#SBATCH --output=~\/science-studio\/p1\/\.ss-jobs\/cjob-x\/stdout/);
  assert.match(header, /#SBATCH --partition=a800/); // binding default wins over endpoint
  assert.match(header, /#SBATCH --time=2:00:00/); // endpoint default when none
  assert.match(script, /\n\n#!\/bin\/bash/);
  // an explicit caller partition beats every default
  const own = buildSbatchScript({ ...input, partition: "cpu" }, ENDPOINT, { partition: "a800" }, paths, "cjob-x");
  assert.match(own, /#SBATCH --partition=cpu/);
});

test("a slurm submit uploads the script then sbatch-parses it — one row", async () => {
  const ssh = fakeSsh([
    { match: /^mkdir -p/, result: {} },
    { match: /^cat > /, result: {} },
    { match: /sbatch --parsable/, result: { stdout: "4242\n" } },
  ]);
  const store = records();
  const job = await submitJob(
    {
      ssh,
      records: store,
      endpoints: async () => [ENDPOINT],
      bindingOf: async () => ({ endpoint: "cluster-a" }),
    },
    { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => [] },
  );
  assert.equal(job.remoteJobId, "4242");
  assert.equal(job.state, "pending");
  assert.equal(job.kind, "slurm");
  assert.match(job.script ?? "", /^#SBATCH --job-name=cjob-/);
  assert.match(job.remoteDir ?? "", /\.ss-jobs\/cjob-/);
  assert.equal((await store.listComputeJobs("p1")).length, 1);
  assert.equal(ssh.calls.length, 3);
  assert.match(ssh.calls[0]?.command ?? "", /^mkdir -p "\$HOME"\/'science-studio\/p1\/\.ss-jobs\/cjob-/);
  assert.match(ssh.calls[1]?.command ?? "", /^cat > "\$HOME"\/'science-studio\/p1\/\.ss-jobs\/cjob-[^']+\/script\.sh'$/);
  assert.match(ssh.calls[1]?.stdin ?? "", /#SBATCH/);
  assert.match(ssh.calls[2]?.command ?? "", /^sbatch --parsable "\$HOME"\/'science-studio\/p1\/\.ss-jobs\/cjob-[^']+\/script\.sh'$/);
});

test("an ambiguous sbatch (exit 0, unparsable id) is a 502 and writes NO row", async () => {
  const ssh = fakeSsh([{ match: /sbatch/, result: { stdout: "Submitted batch job 4242\n" } }]);
  const store = records();
  await assert.rejects(
    submitJob(
      { ssh, records: store, endpoints: async () => [ENDPOINT], bindingOf: async () => ({ endpoint: "cluster-a" }) },
      { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => [] },
    ),
    (err: unknown) => (err as HpcError).status === 502 && /may be queued/.test((err as Error).message),
  );
  assert.deepEqual(await store.listComputeJobs("p1"), []);
});

test("a failing sbatch answers 502 with the cluster's own words", async () => {
  const ssh = fakeSsh([{ match: /sbatch/, result: { code: 1, stderr: "Invalid partition" } }]);
  await assert.rejects(
    submitJob(
      {
        ssh,
        records: records(),
        endpoints: async () => [ENDPOINT],
        bindingOf: async () => ({ endpoint: "cluster-a" }),
      },
      { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => [] },
    ),
    /Invalid partition/,
  );
});

test("a linux submit uploads the script and captures the pid", async () => {
  const ssh = fakeSsh([{ match: /^cat > /, result: {} }, { match: /^nohup setsid/, result: { stdout: "424\n" } }]);
  const store = records();
  const job = await submitJob(
    {
      ssh,
      records: store,
      endpoints: async () => [LINUX_ENDPOINT],
      bindingOf: async () => ({ endpoint: "box-1" }),
    },
    { projectId: "p1", input: parseSubmitBody({ name: "n", script: "echo hi" }), getOpenJobs: async () => [] },
  );
  assert.equal(job.remoteJobId, "424");
  assert.equal(job.state, "submitted");
});

test("the endpoint cap rejects over-limit submits (429)", async () => {
  const capped: HpcEndpointSettings = { ...ENDPOINT, maxConcurrentJobs: 1 };
  const open: ComputeJob[] = [];
  const ssh = fakeSsh([{ match: /sbatch/, result: { stdout: "7\n" } }]);
  const store = records();
  const deps = {
    ssh,
    records: store,
    endpoints: async () => [capped],
    bindingOf: async () => ({ endpoint: "cluster-a" }),
  };
  const first = await submitJob(deps, {
    projectId: "p1",
    input: parseSubmitBody({ name: "n", script: "s" }),
    getOpenJobs: async () => [],
  });
  open.push(first);
  await assert.rejects(
    submitJob(deps, { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => open }),
    (err: unknown) => (err as HpcError).status === 429,
  );
  // the cap is per ENDPOINT: an open job on a DIFFERENT endpoint does not count
  await submitJob(
    { ...deps, endpoints: async () => [ENDPOINT, capped] },
    {
      projectId: "p1",
      input: parseSubmitBody({ name: "n", script: "s", partition: undefined }),
      getOpenJobs: async () => [{ ...first, endpointId: "cluster-b" }],
    },
  );
});

test("a missing binding is a friendly 400, a dangling endpoint too", async () => {
  const deps = {
    ssh: fakeSsh([]),
    records: records(),
    endpoints: async () => [ENDPOINT],
    bindingOf: async () => null,
  };
  await assert.rejects(
    submitJob(deps, { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => [] }),
    (err: unknown) => (err as HpcError).status === 400 && /not bound/.test((err as Error).message),
  );
  await assert.rejects(
    submitJob(
      { ...deps, bindingOf: async () => ({ endpoint: "gone" }) },
      { projectId: "p1", input: parseSubmitBody({ name: "n", script: "s" }), getOpenJobs: async () => [] },
    ),
    /unknown endpoint/,
  );
});

test("an unsafe binding workDir is refused at submit", () => {
  assert.throws(() => resolveWorkDir("p1", { endpoint: "cluster-a", workDir: "~/bad dir" }), (err: unknown) => (err as HpcError).status === 400);
});
