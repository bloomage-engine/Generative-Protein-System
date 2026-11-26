import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore } from "@gps/record";
import { LocalEnvironmentProvider, NullWorkspace, type RuntimeAdapter } from "@gps/transport";
import { createRecordDirectory } from "../src/directory.js";
import { createProjectScopes } from "../src/project-scope.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;

async function harness() {
  const store = await createInMemoryRecordStore();
  await store.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  await store.addWorktree({ id: "main", projectId: "project-default", name: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" });
  await store.addWorktree({ id: "exp-a", projectId: "project-default", name: "A", branch: "exp/a", createdAt: "2026-01-01T00:00:00.000Z" });
  const directory = createRecordDirectory({ store });
  const environments = new LocalEnvironmentProvider({
    environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
  });
  const scope = createProjectScopes({ environments, directory, defaultProjectId: "project-default" });
  const request = (query: Record<string, string>) =>
    ({ query, body: {}, principal: { id: "u", tenant: "t" } }) as never;
  return { scope, request };
}

test("a missing worktree claim defaults to main", async () => {
  const { scope, request } = await harness();
  const claim = await scope.claim(request({}));
  assert.equal(claim.worktreeId, "main");
});

test("a claimed worktree is honored", async () => {
  const { scope, request } = await harness();
  const acquired = await scope.acquire(request({ worktreeId: "exp-a" }));
  assert.equal(acquired.worktreeId, "exp-a");
});

test("an unknown worktree is rejected, never defaulted", async () => {
  const { scope, request } = await harness();
  await assert.rejects(() => scope.acquire(request({ worktreeId: "nope" })));
});
