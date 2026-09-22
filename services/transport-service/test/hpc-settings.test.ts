import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HpcEndpointSettings, RuntimeSettingsView } from "@science-studio/transport";
import { loadSettings, mergeSettings, parseSettingsPatch, viewOf } from "../src/settings.js";
import { emptySettings } from "../src/settings.js";

const GOOD: HpcEndpointSettings = {
  id: "cluster-a",
  name: "Cluster A",
  kind: "slurm",
  host: "hpc.example",
  user: "alice",
  keyPath: "/home/alice/.ssh/id_ed25519",
  defaultPartition: "gpu",
  maxConcurrentJobs: 8,
};

test("parseSettingsPatch accepts a valid hpc list and normalizes it", () => {
  const parsed = parseSettingsPatch({ hpc: { endpoints: [GOOD] } });
  assert.ok("patch" in parsed);
  assert.deepEqual(parsed.patch.hpc?.endpoints, [GOOD]);
});

test("parseSettingsPatch rejects every malformed shape", () => {
  assert.match((parseSettingsPatch({ hpc: { endpoints: [{ ...GOOD, kind: "pbs" }] } }) as { error: string }).error, /kind/);
  assert.match((parseSettingsPatch({ hpc: { endpoints: [{ ...GOOD, id: "Bad ID" }] } }) as { error: string }).error, /\.id/);
  assert.match((parseSettingsPatch({ hpc: { endpoints: [{ ...GOOD }, { ...GOOD }] } }) as { error: string }).error, /duplicate/);
  assert.match((parseSettingsPatch({ hpc: { endpoints: "no" } }) as { error: string }).error, /array/);
  assert.match((parseSettingsPatch({ hpc: { endpoints: [{ ...GOOD, port: 99999 }] } }) as { error: string }).error, /port/);
  assert.match((parseSettingsPatch({ hpc: { endpoints: [{ ...GOOD, maxConcurrentJobs: -1 }] } }) as { error: string }).error, /maxConcurrent/);
});

test("null clears every endpoint; absent keeps the list", () => {
  const base = { ...emptySettings(), hpc: { endpoints: [GOOD] } } as Awaited<ReturnType<typeof loadSettings>>;
  const cleared = mergeSettings(base, { hpc: { endpoints: null } });
  assert.deepEqual(cleared.hpc?.endpoints, []);
  const kept = mergeSettings(base, {});
  assert.deepEqual(kept.hpc?.endpoints, base.hpc?.endpoints);
});

test("a hand-edited settings file with a bad endpoint loses the list, not the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-hpc-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({ model: { provider: "ollama-local" }, plugins: {}, agent: {}, hpc: { endpoints: [{ id: "x", name: "X", kind: "slurm", host: "h", bogus: 1 }, { id: "BAD ID" }] } }),
      "utf8",
    );
    const settings = await loadSettings(path);
    assert.equal(settings.model.provider, "ollama-local"); // the rest of the file survives
    assert.deepEqual(settings.hpc?.endpoints, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the settings view carries the endpoints (a key is a PATH, not a secret)", () => {
  const view: RuntimeSettingsView = viewOf(
    { ...emptySettings(), hpc: { endpoints: [GOOD] } },
    "/tmp/settings.json",
    {},
  );
  assert.equal(view.hpc.endpoints[0]?.keyPath, "/home/alice/.ssh/id_ed25519");
});
