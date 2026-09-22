import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScpArgs, buildSshArgs, remotePath, sshOptions, sshTarget } from "../src/hpc/ssh.js";
import { ENDPOINT, LINUX_ENDPOINT } from "./hpc-support.js";

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
