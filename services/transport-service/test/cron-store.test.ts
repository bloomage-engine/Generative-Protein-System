import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspace } from "@science-studio/workspace";
import { createCronStore, type CronStore } from "../src/cron/store.js";

async function fixture<T>(
  fn: (store: CronStore, workspace: FsWorkspace, root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-store-"));
  const workspace = new FsWorkspace(root, { agentRoot: root });
  const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
  try {
    return await fn(store, workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("write/read/list round-trips a task and a missing log is empty", async () => {
  await fixture(async (store, workspace) => {
    const task = await store.write(workspace, {
      id: "digest",
      name: "Digest",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "Summarize.",
    });
    assert.equal(task.updatedAt, "2026-09-18T00:00:00.000Z");
    assert.equal((await store.read(workspace, "digest"))?.name, "Digest");
    const listing = await store.list(workspace);
    assert.equal(listing.invalid.length, 0);
    assert.deepEqual(listing.tasks.map((t) => t.id), ["digest"]);
    assert.equal(listing.tasks[0]?.lastRun, undefined);
  });
});

test("write stamps createdAt once and preserves it on update", async () => {
  await fixture(async (store, workspace) => {
    const created = await store.write(workspace, {
      id: "digest",
      name: "Digest",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: "",
    });
    assert.equal(created.createdAt, "2026-09-18T00:00:00.000Z");
    const updated = await store.write(workspace, { ...created, name: "Renamed" });
    assert.equal(updated.createdAt, "2026-09-18T00:00:00.000Z");
    assert.equal((await store.read(workspace, "digest"))?.createdAt, "2026-09-18T00:00:00.000Z");
  });
});

test("a malformed file is reported as invalid, never as a task", async () => {
  await fixture(async (store, workspace, root) => {
    await store.write(workspace, { id: "ok", name: "OK", schedule: "0 9 * * *", enabled: true, prompt: "" });
    await mkdir(join(root, ".science-studio", "cron"), { recursive: true });
    await writeFile(join(root, ".science-studio", "cron", "broken.md"), "not a task");
    const listing = await store.list(workspace);
    assert.deepEqual(listing.tasks.map((t) => t.id), ["ok"]);
    assert.equal(listing.invalid.length, 1);
    assert.match(listing.invalid[0]!.error, /frontmatter/);
  });
});

test("appendLog records the latest run on the listing, and remove deletes both files", async () => {
  await fixture(async (store, workspace) => {
    await store.write(workspace, { id: "digest", name: "Digest", schedule: "0 9 * * *", enabled: true, prompt: "" });
    await store.appendLog(workspace, "digest", {
      at: "2026-09-18T09:00:00.000Z",
      status: "success",
      sessionId: "s1",
      message: "done",
    });
    const listing = await store.list(workspace);
    assert.equal(listing.tasks[0]?.lastRun?.status, "success");
    await store.remove(workspace, "digest");
    assert.equal(await store.read(workspace, "digest"), null);
    assert.deepEqual((await store.list(workspace)).tasks, []);
  });
});
