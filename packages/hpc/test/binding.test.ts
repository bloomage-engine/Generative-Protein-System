import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HPC_BINDING_PATH,
  isValidEndpointId,
  parseHpcBinding,
  serializeHpcBinding,
  type HpcBinding,
} from "../src/binding.js";

const BINDING: HpcBinding = {
  endpoint: "cluster-a",
  partition: "gpu",
  workDir: "~/ss-proj42",
  defaultTime: "4:00:00",
  notes: "gpus are A100; queue long on Mondays.",
};

test("a binding document round-trips through serialize/parse", () => {
  const parsed = parseHpcBinding(serializeHpcBinding(BINDING));
  assert.ok("binding" in parsed);
  assert.deepEqual(parsed.binding, BINDING);
});

test("an empty binding body parses to empty notes, absent fields stay absent", () => {
  const text = serializeHpcBinding({ endpoint: "x1", notes: "" });
  const parsed = parseHpcBinding(text);
  assert.ok("binding" in parsed);
  assert.deepEqual(parsed.binding, { endpoint: "x1", notes: "" });
});

test("a hand-edited unquoted scalar still parses", () => {
  const parsed = parseHpcBinding('---\nendpoint: cluster-a\n---\nnotes here\n');
  assert.ok("binding" in parsed);
  assert.equal(parsed.binding.endpoint, "cluster-a");
  assert.equal(parsed.binding.notes, "notes here\n");
});

test("parse rejects malformed documents with a reason", () => {
  assert.ok("error" in parseHpcBinding("no frontmatter"));
  assert.ok("error" in parseHpcBinding("---\nendpoint: \"x\"\n"));
  assert.ok("error" in parseHpcBinding('---\nname: "x"\n---\n')); // no endpoint
  assert.ok("error" in parseHpcBinding('---\nendpoint: "Cluster A!"\n---\n')); // bad id
});

test("ids follow the cron grammar and the path is the product namespace", () => {
  assert.equal(HPC_BINDING_PATH, ".science-studio/hpc.md");
  assert.equal(isValidEndpointId("cluster-a"), true);
  assert.equal(isValidEndpointId("Cluster-a"), false);
  assert.equal(isValidEndpointId("-x"), false);
  assert.equal(isValidEndpointId("x".repeat(65)), false);
});
