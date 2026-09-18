import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {},
    abort: () => {},
  };
}

async function withServer<T>(root: string, fn: (base: string) => Promise<T>): Promise<T> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace: new FsWorkspace(root, { agentRoot: root }) }),
    }),
    cors: { origin: true },
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

test("cron CRUD creates, lists, reads, updates and deletes a task file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-routes-"));
  try {
    await withServer(root, async (base) => {
      const created = await fetch(`${base}/api/cron/task?projectId=p1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Daily digest", schedule: "0 9 * * *", prompt: "Summarize." }),
      });
      assert.equal(created.status, 201);
      const { task } = (await created.json()) as { task: { id: string } };
      assert.equal(task.id, "daily-digest");

      const list = await (await fetch(`${base}/api/cron?projectId=p1`)).json();
      assert.equal((list as { tasks: unknown[] }).tasks.length, 1);

      const one = await fetch(`${base}/api/cron/task?projectId=p1&id=daily-digest`);
      assert.equal(one.status, 200);

      const saved = await fetch(`${base}/api/cron/task?projectId=p1&id=daily-digest`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed", schedule: "0 10 * * *", prompt: "X", enabled: false }),
      });
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as { task: { name: string } }).task.name, "Renamed");

      const removed = await fetch(`${base}/api/cron/task/delete?projectId=p1&id=daily-digest`, { method: "POST" });
      assert.equal(removed.status, 200);
      assert.equal((await (await fetch(`${base}/api/cron?projectId=p1`)).json() as { tasks: unknown[] }).tasks.length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid schedule is a 400, an unknown id a 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-routes-"));
  try {
    await withServer(root, async (base) => {
      const bad = await fetch(`${base}/api/cron/task?projectId=p1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", schedule: "nope", prompt: "y" }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${base}/api/cron/task?projectId=p1&id=missing`)).status, 404);
      assert.equal((await fetch(`${base}/api/cron/task?projectId=p1&id=bad%20id`)).status, 400);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
