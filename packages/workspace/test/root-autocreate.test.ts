import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorkspace } from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

test("list('') auto-creates a missing root as an empty workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "ss-root-absent-"));
  // Deliberately do NOT create `base/proj/` — only its parent.
  const projDir = join(base, "proj");
  try {
    const ws = new FsWorkspace(projDir, { agentRoot: AGENT_ROOT });
    const listing = await ws.list();
    assert.equal(listing.path, "");
    assert.deepEqual(listing.entries, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("list('') is idempotent when the root already exists", async () => {
  const base = await mkdtemp(join(tmpdir(), "ss-root-persist-"));
  const projDir = join(base, "proj");
  try {
    const ws = new FsWorkspace(projDir, { agentRoot: AGENT_ROOT });
    await ws.list();
    await ws.list();
    assert.deepEqual((await ws.list()).entries, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("non-root paths on a missing root STILL raise WorkspaceNotFoundError", async () => {
  const base = await mkdtemp(join(tmpdir(), "ss-root-absent-nested-"));
  const projDir = join(base, "proj");
  try {
    const ws = new FsWorkspace(projDir, { agentRoot: AGENT_ROOT });
    // The root itself was not created; a nested path is missing too.
    await assert.rejects(() => ws.stat("sub/file.txt"), /not found in workspace/);
    // stat on a subdirectory must also fail (root doesn't exist yet).
    await assert.rejects(() => ws.stat("sub"), /not found in workspace/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
