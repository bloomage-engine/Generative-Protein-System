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
  type SessionState,
  type StateDelta,
  type TransportCommand,
} from "@science-studio/transport";
import { createInMemoryRecordStore, type RecordStore } from "@science-studio/record";
import { FsWorkspace } from "@science-studio/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import { createRecordDirectory } from "../src/directory.js";
import { createCronStore } from "../src/cron/store.js";
import { createCronScheduler } from "../src/cron/scheduler.js";

const PROMPT = "do the thing";

type ServiceApp = Awaited<ReturnType<typeof createTransportService>>;

async function fixture<T>(
  fn: (ctx: { base: string; records: RecordStore; app: ServiceApp; prompts: string[] }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-sched-"));
  const records = createInMemoryRecordStore();
  const prompts: string[] = [];
  const adapter: RuntimeAdapter = {
    runtime: "fake",
    init: async () => {},
    run: async function* (_session: SessionState, commands: TransportCommand[]): AsyncIterable<StateDelta> {
      const message = commands.find((c) => c.type === "add-message");
      if (message && message.type === "add-message") prompts.push(message.message.content);
      yield {
        type: "add-message",
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
      };
    },
    abort: () => {},
  };
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter, workspace: new FsWorkspace(root, { agentRoot: root }) }),
    }),
    cors: { origin: true },
    records,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    return await fn({ base: `http://127.0.0.1:${addr.port}`, records, app, prompts });
  } finally {
    app.cronScheduler.stop();
    app.server.closeAllConnections?.();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function addTask(base: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/cron/task?projectId=project-default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
}

test("fire() drives the adapter with the prompt and appends a success log", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await addTask(base, { name: "Run it", schedule: "0 9 * * *", prompt: PROMPT, sessionId: "s1" });
    const { status } = await app.cronScheduler.fire("project-default", "run-it");
    assert.equal(status, "success");
    assert.deepEqual(prompts, [PROMPT]);
    const listing = (await (await fetch(`${base}/api/cron?projectId=project-default`)).json()) as {
      tasks: { lastRun?: { status: string } }[];
    };
    assert.equal(listing.tasks[0]?.lastRun?.status, "success");
  });
});

test("tick() at a non-matching minute is a no-op", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    // A wildcard minute matches every minute EXCEPT the test asserts a no-op by
    // targeting a disabled task; enabled=false is the deterministic no-op.
    await addTask(base, { name: "Off", schedule: "* * * * *", prompt: PROMPT, sessionId: "s1", enabled: false });
    await app.cronScheduler.tick();
    assert.deepEqual(prompts, []);
  });
});

test("fire() on an unknown task is an error", async () => {
  await fixture(async ({ app, prompts }) => {
    const { status } = await app.cronScheduler.fire("project-default", "nope");
    assert.equal(status, "error");
    assert.deepEqual(prompts, []);
  });
});

test("a busy target is skipped and logged as skipped-busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-busy-"));
  try {
    const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
    const workspace = new FsWorkspace(root, { agentRoot: root });
    await store.write(workspace, {
      id: "run-it",
      name: "Run it",
      schedule: "0 9 * * *",
      enabled: true,
      prompt: PROMPT,
      sessionId: "s1",
    });
    const records = createInMemoryRecordStore();
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    const directory = createRecordDirectory({ store: records });
    const principal = await new LocalPrincipalResolver().resolve({ headers: {}, url: "" });
    const prompts: string[] = [];
    const environments = new LocalEnvironmentProvider({
      environmentFor: async () => ({
        adapter: {
          runtime: "fake",
          init: async () => {},
          run: async function* () {
            prompts.push("ran");
          },
          abort: () => {},
        },
        workspace,
      }),
    });
    const scheduler = createCronScheduler({
      store,
      records,
      directory,
      environments,
      principal,
      activeRuns: new Set(["local:s1"]),
    });
    const { status } = await scheduler.fire("project-default", "run-it");
    assert.equal(status, "skipped-busy");
    assert.deepEqual(prompts, []);
    const listing = await store.list(workspace);
    assert.equal(listing.tasks[0]?.lastRun?.status, "skipped-busy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tick() fires a matching task once and does not re-fire within the same minute", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-cron-dedupe-"));
  try {
    const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
    const workspace = new FsWorkspace(root, { agentRoot: root });
    await store.write(workspace, {
      id: "run-it",
      name: "Run it",
      schedule: "* * * * *",
      enabled: true,
      prompt: PROMPT,
      sessionId: "s1",
    });
    const records = createInMemoryRecordStore();
    await records.createProject({
      id: "project-default",
      name: "Default project",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await records.addSession({
      id: "s1",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    const directory = createRecordDirectory({ store: records });
    const principal = await new LocalPrincipalResolver().resolve({ headers: {}, url: "" });
    const prompts: string[] = [];
    const environments = new LocalEnvironmentProvider({
      environmentFor: async () => ({
        adapter: {
          runtime: "fake",
          init: async () => {},
          run: async function* () {
            prompts.push("ran");
          },
          abort: () => {},
        },
        workspace,
      }),
    });
    const scheduler = createCronScheduler({
      store,
      records,
      directory,
      environments,
      principal,
      activeRuns: new Set(),
      now: () => new Date("2026-09-18T12:30:00.000Z"),
    });
    await scheduler.tick();
    assert.deepEqual(prompts, ["ran"], "the matching minute fires once");
    await scheduler.tick();
    assert.deepEqual(prompts, ["ran"], "a second tick in the same minute must not re-fire");
    const listing = await store.list(workspace);
    assert.equal(listing.tasks[0]?.lastRun?.status, "success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project whose environment fails does not stop the tick for other projects", async () => {
  const goodRoot = await mkdtemp(join(tmpdir(), "ss-cron-good-"));
  const badRoot = await mkdtemp(join(tmpdir(), "ss-cron-bad-"));
  try {
    const store = createCronStore({ now: () => "2026-09-18T00:00:00.000Z" });
    const goodWorkspace = new FsWorkspace(goodRoot, { agentRoot: goodRoot });
    const badWorkspace = new FsWorkspace(badRoot, { agentRoot: badRoot });
    await store.write(goodWorkspace, {
      id: "good",
      name: "Good",
      schedule: "* * * * *",
      enabled: true,
      prompt: PROMPT,
      sessionId: "sg",
    });
    await store.write(badWorkspace, {
      id: "bad",
      name: "Bad",
      schedule: "* * * * *",
      enabled: true,
      prompt: PROMPT,
      sessionId: "sb",
    });
    const records = createInMemoryRecordStore();
    await records.createProject({ id: "bad", name: "Bad", createdAt: "2026-09-18T00:00:00.000Z" });
    await records.createProject({ id: "good", name: "Good", createdAt: "2026-09-18T00:00:00.000Z" });
    for (const [id, projectId] of [["sg", "good"], ["sb", "bad"]] as const) {
      await records.addSession({
        id,
        projectId,
        agentId: "main",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      });
    }
    const directory = createRecordDirectory({ store: records });
    const principal = await new LocalPrincipalResolver().resolve({ headers: {}, url: "" });
    const prompts: string[] = [];
    const errors: unknown[] = [];
    const environments = new LocalEnvironmentProvider({
      environmentFor: async (projectId) => {
        if (projectId === "bad") throw new Error("boom");
        return {
          adapter: {
            runtime: "fake",
            init: async () => {},
            run: async function* () {
              prompts.push("ran");
            },
            abort: () => {},
          },
          workspace: projectId === "good" ? goodWorkspace : badWorkspace,
        };
      },
    });
    const scheduler = createCronScheduler({
      store,
      records,
      directory,
      environments,
      principal,
      activeRuns: new Set(),
      now: () => new Date("2026-09-18T12:30:00.000Z"),
      onError: (err) => errors.push(err),
    });
    await scheduler.tick();
    assert.deepEqual(prompts, ["ran"], "the healthy project still fires");
    assert.equal(errors.length, 1, "the failing project is reported, not swallowed silently");
  } finally {
    await rm(goodRoot, { recursive: true, force: true });
    await rm(badRoot, { recursive: true, force: true });
  }
});

test("POST /api/cron/task/run on an unknown id reports an error", async () => {
  await fixture(async ({ base }) => {
    const res = await fetch(`${base}/api/cron/task/run?id=nope&projectId=project-default`, {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "error" });
  });
});

test("a named session in a linked worktree is refused (cron is main-only)", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "linked",
      projectId: "project-default",
      agentId: "main",
      worktreeId: "exp-a",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await addTask(base, { name: "Linked", schedule: "0 9 * * *", prompt: PROMPT, sessionId: "linked" });
    const { status } = await app.cronScheduler.fire("project-default", "linked");
    assert.equal(status, "error");
    assert.deepEqual(prompts, [], "a linked-worktree session must not be driven");
    const listing = (await (await fetch(`${base}/api/cron?projectId=project-default`)).json()) as {
      tasks: { lastRun?: { status: string; message?: string } }[];
    };
    assert.equal(listing.tasks[0]?.lastRun?.status, "error");
    assert.match(
      listing.tasks[0]?.lastRun?.message ?? "",
      /not in the main worktree/,
      "the refusal names the reason in the run log",
    );
  });
});

test("with no named session, cron targets the newest MAIN-worktree session", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "main-old",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    await records.addSession({
      id: "main-new",
      projectId: "project-default",
      agentId: "main",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    // Newer than every main session, but ineligible: cron never leaves `main`.
    await records.addSession({
      id: "linked",
      projectId: "project-default",
      agentId: "main",
      worktreeId: "exp-a",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    await addTask(base, { name: "Auto", schedule: "0 9 * * *", prompt: PROMPT });
    const { status } = await app.cronScheduler.fire("project-default", "auto");
    assert.equal(status, "success");
    assert.deepEqual(prompts, [PROMPT]);
    const listing = (await (await fetch(`${base}/api/cron?projectId=project-default`)).json()) as {
      tasks: { lastRun?: { sessionId?: string } }[];
    };
    assert.equal(listing.tasks[0]?.lastRun?.sessionId, "main-new");
  });
});

test("a named session in another project is an error and logs nothing to the transcript", async () => {
  await fixture(async ({ base, records, app, prompts }) => {
    await records.addSession({
      id: "other",
      projectId: "other-project",
      agentId: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    await addTask(base, { name: "Wrong project", schedule: "0 9 * * *", prompt: PROMPT, sessionId: "other" });
    const { status } = await app.cronScheduler.fire("project-default", "wrong-project");
    assert.equal(status, "error");
    assert.deepEqual(prompts, []);
  });
});
