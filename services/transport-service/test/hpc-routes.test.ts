import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRecordStore, type ComputeJob } from "@gps/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
} from "@gps/transport";
import { FsWorkspace } from "@gps/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import type { SshRunner } from "../src/hpc/ssh.js";
import { ENDPOINT, LINUX_ENDPOINT, fakeSsh } from "./hpc-support.js";

function fakeAdapter(): RuntimeAdapter {
  return { runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} };
}

async function withHpc<T>(
  ssh: SshRunner,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gps-hpc-routes-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "gps-hpc-cfg-"));
  const settingsPath = join(settingsDir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ model: {}, plugins: {}, agent: {}, hpc: { endpoints: [ENDPOINT, LINUX_ENDPOINT] } }),
    "utf8",
  );
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new FsWorkspace(root, { agentRoot: root }) }),
    }),
    cors: { origin: true },
    records: createInMemoryRecordStore(),
    settingsPath,
    hpcSsh: ssh,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
}

const json = { "content-type": "application/json" };

test("GET /api/hpc/endpoints serves the deployment list as-is", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const res = await fetch(`${base}/api/hpc/endpoints`);
    const { endpoints } = (await res.json()) as { endpoints: Array<{ id: string; keyPath?: string }> };
    assert.deepEqual(endpoints.map((e) => e.id), ["cluster-a", "box-1"]);
    assert.equal(endpoints[0]?.keyPath, ENDPOINT.keyPath); // a PATH — not secret material
  });
});

test("binding: absent → false, PUT writes the file, GET parses it", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const none = await (await fetch(`${base}/api/hpc/binding?projectId=p1`)).json();
    assert.deepEqual(none, { bound: false });
    const put = await fetch(`${base}/api/hpc/binding?projectId=p1`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ endpoint: "cluster-a", partition: "a800", notes: "A100s only." }),
    });
    assert.equal(put.status, 200);
    const got = (await (await fetch(`${base}/api/hpc/binding?projectId=p1`)).json()) as {
      bound: boolean;
      binding: { endpoint: string; partition?: string; notes: string };
    };
    assert.equal(got.bound, true);
    assert.equal(got.binding.endpoint, "cluster-a");
    assert.equal(got.binding.partition, "a800");
    assert.equal(got.binding.notes, "A100s only.");
  });
});

test("binding PUT validates: unknown endpoint 400, unsafe workDir 400", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const bad = await fetch(`${base}/api/hpc/binding?projectId=p1`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ endpoint: "ghost" }),
    });
    assert.equal(bad.status, 400);
    const unsafe = await fetch(`${base}/api/hpc/binding?projectId=p1`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ endpoint: "cluster-a", workDir: "~/two words" }),
    });
    assert.equal(unsafe.status, 400);
  });
});

test("submit writes a row and the ledger answers open-first", async () => {
  const ssh = fakeSsh([{ match: /sbatch --parsable/, result: { stdout: "4242\n" } }]);
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ endpoint: "cluster-a" }),
    });
    const submitted = await fetch(`${base}/api/hpc/jobs?projectId=p1`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "md run", script: "#!/bin/bash\necho hi\n" }),
    });
    assert.equal(submitted.status, 201);
    const { job } = (await submitted.json()) as { job: ComputeJob };
    assert.equal(job.remoteJobId, "4242");
    assert.equal(job.projectId, "p1");
    const list = (await (await fetch(`${base}/api/hpc/jobs?projectId=p1`)).json()) as { jobs: ComputeJob[] };
    assert.equal(list.jobs.length, 1);
    assert.equal(list.jobs[0]?.state, "pending");
  });
});

test("an unbound Project cannot submit (friendly 400)", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const res = await fetch(`${base}/api/hpc/jobs?projectId=p1`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "x", script: "s" }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not bound/);
  });
});

test("a malformed submit body is a 400", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const res = await fetch(`${base}/api/hpc/jobs?projectId=p1`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "" }),
    });
    assert.equal(res.status, 400);
  });
});

test("cancel sends scancel and settles the row; a second cancel is 409", async () => {
  const ssh = fakeSsh([{ match: /sbatch --parsable/, result: { stdout: "4242\n" } }]);
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, { method: "PUT", headers: json, body: JSON.stringify({ endpoint: "cluster-a" }) });
    const { job } = (await (
      await fetch(`${base}/api/hpc/jobs?projectId=p1`, { method: "POST", headers: json, body: JSON.stringify({ name: "n", script: "s" }) })
    ).json()) as { job: ComputeJob };
    const cancelled = await fetch(`${base}/api/hpc/jobs/${job.id}/cancel?projectId=p1`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { job: ComputeJob }).job.state, "cancelled");
    assert.ok(ssh.calls.some((c) => c.command === "scancel 4242"));
    const again = await fetch(`${base}/api/hpc/jobs/${job.id}/cancel?projectId=p1`, { method: "POST" });
    assert.equal(again.status, 409);
  });
});

test("logs tails the stored log home over ssh", async () => {
  const ssh = fakeSsh([
    { match: /sbatch --parsable/, result: { stdout: "4242\n" } },
    { match: /^tail -c /, result: { stdout: "hello from the cluster\n" } },
  ]);
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, { method: "PUT", headers: json, body: JSON.stringify({ endpoint: "cluster-a", workDir: "~/w" }) });
    const { job } = (await (
      await fetch(`${base}/api/hpc/jobs?projectId=p1`, { method: "POST", headers: json, body: JSON.stringify({ name: "n", script: "s" }) })
    ).json()) as { job: ComputeJob };
    const res = await fetch(`${base}/api/hpc/jobs/${job.id}/logs?projectId=p1&stream=stdout`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { text: string }).text, "hello from the cluster\n");
    const cmd = ssh.calls.find((c) => c.command.startsWith("tail -c "))?.command ?? "";
    assert.match(cmd, /^tail -c 65536 "\$HOME"\/'w\/\.gps-jobs\/cjob-[^/]+\/stdout'$/);
  });
});

test("refresh reconciles from the cluster into the ledger (docs/adr/0024 read model)", async () => {
  const ssh = fakeSsh([
    { match: /sbatch --parsable/, result: { stdout: "4242\n" } },
    { match: /squeue -h/, result: { stdout: "4242|R|gpu|node01|None\n" } },
  ]);
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, { method: "PUT", headers: json, body: JSON.stringify({ endpoint: "cluster-a" }) });
    const { job } = (await (
      await fetch(`${base}/api/hpc/jobs?projectId=p1`, { method: "POST", headers: json, body: JSON.stringify({ name: "n", script: "s" }) })
    ).json()) as { job: ComputeJob };
    const refreshed = (await (
      await fetch(`${base}/api/hpc/jobs/refresh?projectId=p1`, { method: "POST" })
    ).json()) as { jobs: ComputeJob[] };
    assert.equal(refreshed.jobs[0]?.state, "running");
    assert.equal(refreshed.jobs[0]?.nodeList, "node01");
    assert.ok(job.id);
  });
});

test("probe answers per-check, never a thrown 500", async () => {
  const ssh = fakeSsh([
    { match: /^uname -srm/, result: { stdout: "Linux 5.15 x86_64\n" } },
    { match: /^sbatch --version/, result: { stdout: "slurm 23.11\n" } },
  ]);
  await withHpc(ssh, async (base) => {
    const res = await fetch(`${base}/api/hpc/endpoints/${ENDPOINT.id}/probe`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; os: string; scheduler: string; errors: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.os, "Linux 5.15 x86_64");
    assert.match(body.scheduler, /slurm/);
  });
});

test("probe catches an unreachable slurm controller even when sbatch --version works", async () => {
  const ssh = fakeSsh([
    { match: /^uname -srm/, result: { stdout: "Linux\n" } },
    { match: /^sbatch --version/, result: { stdout: "slurm-wlm 21.08.5\n" } },
    { match: /squeue -h/, result: { stdout: "SLURM-CTL-FAIL\n" } },
  ]);
  await withHpc(ssh, async (base) => {
    const res = await fetch(`${base}/api/hpc/endpoints/${ENDPOINT.id}/probe`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    assert.equal(body.ok, false);
    assert.match(body.errors.join(" "), /unreachable/);
  });
});

test("staging: upload crosses the workspace file raw-grammar path to scp", async () => {
  const ssh = fakeSsh();
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, { method: "PUT", headers: json, body: JSON.stringify({ endpoint: "cluster-a", workDir: "~/w" }) });
    // stage a workspace file first
    const upload = await fetch(`${base}/api/workspace/upload?projectId=p1&path=data/in.pdb`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(upload.status, 200);
    const res = await fetch(`${base}/api/hpc/files?projectId=p1`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "upload", workspacePath: "data/in.pdb", remoteRelPath: "data/in.pdb" }),
    });
    assert.equal(res.status, 200);
    const call = ssh.calls.find((c) => c.command.startsWith("scp-to ")) ?? { command: "" };
    assert.match(call.command, / ~\/w\/data\/in\.pdb$/); // RAW path (scp parses it), not shq-quoted
  });
});

test("staging: download writes through the Workspace seam", async () => {
  const ssh = fakeSsh();
  ssh.copyFrom = async (_e, remote, localPath) => {
    assert.match(remote, /^~\/w\/out\.log$/);
    await writeFile(localPath, "from the cluster");
    return { code: 0, stdout: "", stderr: "" };
  };
  await withHpc(ssh, async (base) => {
    await fetch(`${base}/api/hpc/binding?projectId=p1`, { method: "PUT", headers: json, body: JSON.stringify({ endpoint: "cluster-a", workDir: "~/w" }) });
    const res = await fetch(`${base}/api/hpc/files?projectId=p1`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "download", workspacePath: "out.log", remoteRelPath: "out.log" }),
    });
    assert.equal(res.status, 200);
    const file = await fetch(`${base}/api/workspace/file?projectId=p1&path=out.log`);
    assert.equal(await file.text(), "from the cluster");
  });
});

test("a job from another Project is a 404, an id-shaped-but-unknown is 404 too", async () => {
  await withHpc(fakeSsh(), async (base) => {
    const res = await fetch(`${base}/api/hpc/jobs/cjob-lz4k-abc?projectId=p1`);
    assert.equal(res.status, 404);
    const bad = await fetch(`${base}/api/hpc/jobs/not-a-cjob/cancel?projectId=p1`, { method: "POST" });
    assert.equal(bad.status, 400);
  });
});
