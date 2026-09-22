import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHpcPatch } from "../src/bridge.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

test("writeHpcPatch inserts the hpc plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-hpc-launch-"));
  try {
    const file = await writeHpcPatch({
      dir,
      pluginPath: "/opt/ss/hpc-plugin.js",
      config: { project: META, service: "http://127.0.0.1:3123" },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: science-studio-hpc/);
    assert.match(patch, /hpc-plugin\.js/);
    assert.match(patch, /"service":"http:\/\/127\.0\.0\.1:3123"/);
    assert.match(patch, /"id":"drought-screen"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
