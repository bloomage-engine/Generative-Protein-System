import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRecordStore, type RecordStore } from "@gps/record";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  WorkspacePathError,
  type RuntimeAdapter,
} from "@gps/transport";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";
import { createRecordDirectory } from "../src/directory.js";
import { createProjectScopes } from "../src/project-scope.js";
import { localWorkspace } from "../src/composition.js";
import { isSafeProjectId } from "../src/worktree/paths.js";

/**
 * A CLIENT-SUPPLIED Project claim must never escape `PROJECT_ROOT`. This is
 * enforced once, centrally, in `project-scope`, so every acquiring route answers
 * 400 instead of joining `../../etc` onto the root (docs/adr/0025).
 */
const UNSAFE = "../../etc";

const adapter = (): RuntimeAdapter =>
  ({ runtime: "fake", init: async () => {}, run: async function* () {}, abort: () => {} }) as RuntimeAdapter;

async function withServer<T>(
  records: RecordStore,
  fn: (ctx: { base: string; acquired: string[] }) => Promise<T>,
): Promise<T> {
  const acquired: string[] = [];
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async (projectId) => {
        acquired.push(projectId);
        return { adapter: adapter(), workspace: new NullWorkspace() };
      },
    }),
    cors: { origin: true },
    records,
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    return await fn({ base, acquired });
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

test("the workspace route rejects an unsafe project claim with 400 and acquires nothing", async () => {
  const records = await createInMemoryRecordStore();
  await withServer(records, async ({ base, acquired }) => {
    const res = await fetch(`${base}/api/workspace/entries?project=${encodeURIComponent(UNSAFE)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(acquired, [], "an unsafe claim must not reach the environment");
    assert.equal(await records.getProject(UNSAFE), null, "no Project row was minted for the traversal id");
  });
});

test("the transport route rejects an unsafe project claim with 400 and mints nothing", async () => {
  const records = await createInMemoryRecordStore();
  await withServer(records, async ({ base, acquired }) => {
    const res = await fetch(`${base}/api/transport?project=${encodeURIComponent(UNSAFE)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: [] }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(acquired, [], "an unsafe claim must not reach the environment");
    assert.equal(await records.getProject(UNSAFE), null);
  });
});

test("an unsafe named project is rejected before any file access (400, never a 500)", async () => {
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  await withServer(records, async ({ base, acquired }) => {
    // Delete reaches the Project workspace through `acquireProject`; even
    // though the record has no such Project row, the error must be the
    // caller's 400 (validation precedes the record read). The proof is the
    // status plus the untouched environment/record — a disk assertion would be
    // vacuous here because the fake provider returns a NullWorkspace and never
    // touches PROJECT_ROOT.
    const res = await fetch(`${base}/api/projects/${encodeURIComponent(UNSAFE)}/delete`, {
      method: "POST",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(acquired, [], "an unsafe claim must not reach the environment");
    assert.equal(await records.getProject(UNSAFE), null, "no Project row was minted for the traversal id");
  });
});

test("acquireProject rejects an unsafe project id with a WorkspacePathError", async () => {
  const records = await createInMemoryRecordStore();
  await records.createProject({ id: "project-default", name: "D", createdAt: "2026-01-01T00:00:00.000Z" });
  const scope = createProjectScopes({
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: adapter(), workspace: new NullWorkspace() }),
    }),
    directory: createRecordDirectory({ store: records }),
    defaultProjectId: "project-default",
  });
  const principal = { id: "u", tenant: "t", local: true, roles: [] } as never;
  await assert.rejects(
    () => scope.acquireProject(principal, UNSAFE),
    (err: unknown) => err instanceof WorkspacePathError,
  );
});

test("localWorkspace refuses an unsafe project id as a belt-and-braces guard", () => {
  assert.equal(isSafeProjectId(UNSAFE), false);
  assert.equal(isSafeProjectId(".."), false);
  assert.equal(isSafeProjectId("project-default"), true);
  assert.throws(
    () => localWorkspace({ PROJECT_ROOT: "/tmp/root" }, UNSAFE, "main"),
    (err: unknown) => err instanceof WorkspacePathError,
  );
});
