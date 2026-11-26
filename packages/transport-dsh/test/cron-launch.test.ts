import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCronPatch } from "../src/bridge.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

test("writeCronPatch inserts the cron plugin by file URL with a JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-cron-launch-"));
  try {
    const file = await writeCronPatch({
      dir,
      pluginPath: "/opt/ss/cron-plugin.js",
      config: { project: META, root: "/w/project" },
    });
    const patch = await readFile(file, "utf8");
    assert.match(patch, /- insert:/);
    assert.match(patch, /id: gps-cron/);
    assert.match(patch, /cron-plugin\.js/);
    assert.match(patch, /"root":"\/w\/project"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
