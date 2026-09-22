import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorkDir,
  isSafeRemotePath,
  isValidComputeJobId,
  jobDir,
  jobPaths,
  parseRemotePid,
  parseSlurmJobId,
  shq,
} from "../src/job-layout.js";

test("the default Remote Work Dir names the Project", () => {
  assert.equal(defaultWorkDir("proj-7"), "~/science-studio/proj-7");
});

test("job paths hang under a dot-dir and never double the separator", () => {
  assert.equal(jobDir("~/w", "cjob-1"), "~/w/.ss-jobs/cjob-1");
  assert.equal(jobDir("~/w/", "cjob-1"), "~/w/.ss-jobs/cjob-1");
  const p = jobPaths("~/w", "cjob-1");
  assert.equal(p.dir, "~/w/.ss-jobs/cjob-1");
  assert.equal(p.script, "~/w/.ss-jobs/cjob-1/script.sh");
  assert.equal(p.runner, "~/w/.ss-jobs/cjob-1/run.sh");
  assert.equal(p.stdout, "~/w/.ss-jobs/cjob-1/stdout");
  assert.equal(p.stderr, "~/w/.ss-jobs/cjob-1/stderr");
  assert.equal(p.pid, "~/w/.ss-jobs/cjob-1/pid");
  assert.equal(p.rc, "~/w/.ss-jobs/cjob-1/rc");
});

test("single-quote escaping is POSIX-correct", () => {
  assert.equal(shq("plain"), "'plain'");
  // 'it'\''s' — the canonical sequence: close, escaped quote, reopen.
  assert.equal(shq("it's"), "'it'\\''s'");
  assert.equal(shq(""), "''");
});

test("remote paths are restricted to the space-free safe grammar", () => {
  assert.equal(isSafeRemotePath("~/ss-proj42"), true);
  assert.equal(isSafeRemotePath("/scratch/a/b-c.1_2"), true);
  assert.equal(isSafeRemotePath("~/with space"), false);
  assert.equal(isSafeRemotePath("~/a/../../x"), false);
  assert.equal(isSafeRemotePath("-oProxyCommand=x"), false);
  assert.equal(isSafeRemotePath("~/$(whoami)"), false);
  assert.equal(isSafeRemotePath(""), false);
});

test("slurm --parsable output parses with and without the cluster suffix", () => {
  assert.equal(parseSlurmJobId("12345\n"), "12345");
  assert.equal(parseSlurmJobId("12345;cluster-a"), "12345");
  assert.equal(parseSlurmJobId("Submitted batch job 12345"), null);
  assert.equal(parseSlurmJobId(""), null);
});

test("a remote pid is a positive decimal integer", () => {
  assert.equal(parseRemotePid("4242"), "4242");
  assert.equal(parseRemotePid("0"), null);
  assert.equal(parseRemotePid("sh: line 1: nope"), null);
});

test("row ids are validated as filename-safe", () => {
  assert.equal(isValidComputeJobId("cjob-lz4k2-9x7"), true);
  assert.equal(isValidComputeJobId("subagent-1"), false);
  assert.equal(isValidComputeJobId("cjob-../etc"), false);
});
