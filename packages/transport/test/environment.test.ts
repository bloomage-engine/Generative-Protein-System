import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LocalEnvironmentProvider,
  NullWorkspace,
  type Principal,
  type RuntimeAdapter,
} from "../src/index.js";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;
const principal: Principal = { id: "u", tenant: "t", displayName: "U", roles: [], local: true };

test("environments are cached per (project, worktree)", async () => {
  const built: string[] = [];
  const provider = new LocalEnvironmentProvider({
    environmentFor: async (projectId, worktreeId) => {
      built.push(`${projectId}/${worktreeId}`);
      return { adapter: adapter(), workspace: new NullWorkspace() };
    },
  });
  const a = await provider.acquire(principal, "p1", "main");
  const b = await provider.acquire(principal, "p1", "main");
  const c = await provider.acquire(principal, "p1", "exp-a");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.worktreeId, "main");
  assert.equal(c.worktreeId, "exp-a");
  assert.deepEqual(built, ["p1/main", "p1/exp-a"]);
});

test("release without a worktree releases every child of the project", async () => {
  let calls = 0;
  const provider = new LocalEnvironmentProvider({
    environmentFor: async () => {
      calls += 1;
      return { adapter: adapter(), workspace: new NullWorkspace() };
    },
  });
  await provider.acquire(principal, "p1", "main");
  await provider.acquire(principal, "p1", "exp-a");
  await provider.acquire(principal, "p2", "main");
  await provider.release?.(principal, "p1");
  await provider.acquire(principal, "p1", "main");
  await provider.acquire(principal, "p1", "exp-a");
  assert.equal(calls, 5); // 3 initial + 2 rebuilt
});

test("release with a worktree drops only that one", async () => {
  const provider = new LocalEnvironmentProvider({
    environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
  });
  const first = await provider.acquire(principal, "p1", "exp-a");
  await provider.acquire(principal, "p1", "main");
  await provider.release?.(principal, "p1", "exp-a");
  const rebuilt = await provider.acquire(principal, "p1", "exp-a");
  assert.notEqual(first, rebuilt);
});

test("release during an in-flight acquire prevents re-caching", async () => {
  let resolveBuild!: () => void;
  const gate = new Promise<void>((resolve) => { resolveBuild = resolve; });
  let calls = 0;
  const provider = new LocalEnvironmentProvider({
    environmentFor: async () => {
      calls += 1;
      await gate;
      return { adapter: adapter(), workspace: new NullWorkspace() };
    },
  });
  const first = provider.acquire(principal, "p1", "main");
  const released = provider.release?.(principal, "p1", "main");
  resolveBuild();
  await first;
  await released;
  const rebuilt = await provider.acquire(principal, "p1", "main");
  assert.equal(calls, 2);
  assert.notEqual(await first, rebuilt);
});
