import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScpArgs, buildSshArgs, createSshRunner, remotePath, sshOptions, sshTarget } from "../src/hpc/ssh.js";
import { ENDPOINT } from "./hpc-support.js";

test("sshTarget keeps the [user@]host shape and defers to config without a user", () => {
  assert.equal(sshTarget(ENDPOINT), "alice@hpc.example");
  assert.equal(sshTarget({ ...ENDPOINT, user: undefined }), "hpc.example");
});

test("the fixed -o set is the non-interactive, multiplexing contract", () => {
  const opts = sshOptions("/tmp/cm/cluster-a.sock");
  assert.deepEqual(opts, [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/cm/cluster-a.sock",
    "-o", "ControlPersist=600",
  ]);
});

test("buildSshArgs interpolates port and key as separate argv tokens", () => {
  const args = buildSshArgs({ ...ENDPOINT, port: 2222 }, "/tmp/s", "uname -srm");
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert.equal(args[args.indexOf("-i") + 1], ENDPOINT.keyPath);
  assert.equal(args.at(-2), "alice@hpc.example");
  assert.equal(args.at(-1), "uname -srm");
});

test("scp carries the SAME option set (a cold master must not go interactive)", () => {
  const args = buildScpArgs(ENDPOINT, "/tmp/s", "/tmp/x", "~/w/in.pdb", true);
  const joined = args.join(" ");
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /StrictHostKeyChecking=accept-new/);
  assert.match(joined, /ControlPath=\/tmp\/s/);
  assert.ok(args.includes("/tmp/x"));
  assert.ok(args.includes("alice@hpc.example:~/w/in.pdb"));
});

test("remotePath expands the leading tilde to $HOME and quotes the rest", () => {
  assert.equal(remotePath("~/science-studio/p1"), `"$HOME"/'science-studio/p1'`);
  assert.equal(remotePath("~"), '"$HOME"');
  assert.equal(remotePath("/scratch/a"), "'/scratch/a'");
  assert.equal(remotePath("~/it's/fun"), `"$HOME"/'it'\\''s/fun'`);
});

test("the real spawner works against a not-yet-existing controlDir (the 500 regression)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-hpc-runner-"));
  try {
    const shim = join(root, "ssh-shim.sh");
    await writeFile(shim, "#!/bin/sh\necho \"$@\"\n");
    await chmod(shim, 0o755);
    const ssh = await createSshRunner({
      sshBin: shim,
      scpBin: shim,
      controlDir: join(root, "science-studio", "hpc"), // deliberately absent
    });
    const res = await ssh.run(ENDPOINT, "uname -srm");
    assert.equal(res.code, 0);
    assert.match(res.stdout, /BatchMode=yes/);
    assert.match(res.stdout, /alice@hpc\.example/);
    assert.match(res.stdout, /uname -srm/);
    // The base dir now exists and holds the per-process master dir.
    assert.match(res.stdout, new RegExp(`ControlPath=${join(root, "science-studio", "hpc")}`));
    const copy = await ssh.copyTo(ENDPOINT, shim, "~/w/x.txt");
    assert.equal(copy.code, 0);
    assert.match(copy.stdout, /BatchMode=yes/); // scp carries the same -o set
    assert.match(copy.stdout, /alice@hpc\.example:~\/w\/x\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
