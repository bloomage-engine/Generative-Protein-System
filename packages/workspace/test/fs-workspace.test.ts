import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTooLargeError,
  FsWorkspace,
  WorkspaceEscapeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
} from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ss-workspace-"));
}

/** A root with: `analysis/` (containing `notes.md`), `data.csv`, `README.txt`. */
async function makeFixture(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await makeRoot();
  await mkdir(join(root, "analysis"));
  await writeFile(join(root, "analysis", "notes.md"), "# notes\nsecond line\n");
  await writeFile(join(root, "data.csv"), "a,b\n1,2\n");
  await writeFile(join(root, "README.txt"), "hello");
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

const workspaceFor = (root: string, extra: { maxInlineBytes?: number } = {}) =>
  new FsWorkspace(root, { agentRoot: AGENT_ROOT, ...extra });

test("list returns directories first, then files, with size and mime", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const listing = await workspaceFor(root).list();
    assert.equal(listing.path, "");
    assert.deepEqual(
      listing.entries.map((e) => e.path),
      ["analysis", "data.csv", "README.txt"],
    );
    const dir = listing.entries[0]!;
    assert.equal(dir.kind, "dir");
    assert.equal(dir.size, undefined);
    const csv = listing.entries.find((e) => e.name === "data.csv")!;
    assert.equal(csv.kind, "file");
    assert.equal(csv.size, 8);
    assert.equal(csv.mime, "text/csv");
  } finally {
    await dispose();
  }
});

test("list descends into a subdirectory and returns workspace-relative paths", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const listing = await workspaceFor(root).list("analysis");
    assert.equal(listing.path, "analysis");
    assert.deepEqual(listing.entries.map((e) => e.path), ["analysis/notes.md"]);
  } finally {
    await dispose();
  }
});

test("stat describes files and directories", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const ws = workspaceFor(root);
    const file = await ws.stat("data.csv");
    assert.equal(file.kind, "file");
    assert.equal(file.name, "data.csv");
    assert.equal(file.size, 8);
    assert.equal(file.mime, "text/csv");
    assert.ok(file.modifiedAt, "modifiedAt must be present");

    const dir = await ws.stat("analysis");
    assert.equal(dir.kind, "dir");
    assert.equal(dir.size, undefined);
  } finally {
    await dispose();
  }
});

test("open streams the content with its size and mime", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const content = await workspaceFor(root).open("analysis/notes.md");
    assert.equal(content.size, "# notes\nsecond line\n".length);
    assert.equal(content.mime, "text/markdown");
    assert.equal(await new Response(content.body).text(), "# notes\nsecond line\n");
  } finally {
    await dispose();
  }
});

test("malformed paths are rejected before any filesystem access", async () => {
  const ws = workspaceFor("/nonexistent-root");
  const bad = ["/etc/passwd", "../outside", "a/../../outside", "a\\b", "nul\0byte"];
  for (const path of bad) {
    await assert.rejects(() => ws.stat(path), WorkspacePathError, `stat(${path})`);
    await assert.rejects(() => ws.open(path), WorkspacePathError, `open(${path})`);
    await assert.rejects(() => ws.list(path), WorkspacePathError, `list(${path})`);
  }
});

test("a symlink target is refused", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await symlink(join(root, "data.csv"), join(root, "link.csv"));
    const ws = workspaceFor(root);
    await assert.rejects(() => ws.stat("link.csv"), WorkspaceEscapeError);
    await assert.rejects(() => ws.open("link.csv"), WorkspaceEscapeError);
  } finally {
    await dispose();
  }
});

test("symlink entries are omitted from listings", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await symlink(join(root, "data.csv"), join(root, "link.csv"));
    const listing = await workspaceFor(root).list();
    assert.ok(!listing.entries.some((e) => e.name === "link.csv"));
  } finally {
    await dispose();
  }
});

test("a symlink pointing OUTSIDE the root can never be read", async () => {
  const { root, dispose } = await makeFixture();
  const outside = await makeRoot();
  try {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    const ws = workspaceFor(root);
    await assert.rejects(() => ws.open("escape.txt"), WorkspaceEscapeError);
  } finally {
    await dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test("open enforces the byte cap (stream it as a download instead)", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const ws = workspaceFor(root, { maxInlineBytes: 4 });
    await assert.rejects(() => ws.open("data.csv"), FileTooLargeError);
    // An explicit higher cap still succeeds.
    const content = await ws.open("data.csv", { maxBytes: 1024 });
    assert.equal(content.size, 8);
  } finally {
    await dispose();
  }
});

test("a missing path raises WorkspaceNotFoundError", async () => {
  const { root, dispose } = await makeFixture();
  try {
    const ws = workspaceFor(root);
    await assert.rejects(() => ws.stat("nope.txt"), WorkspaceNotFoundError);
    await assert.rejects(() => ws.list("nope/"), WorkspaceNotFoundError);
  } finally {
    await dispose();
  }
});

test("toAgentPath / toWorkspacePath round-trip and refuse paths outside the root", () => {
  const ws = workspaceFor("/tmp/ignored");
  assert.equal(ws.toAgentPath(""), AGENT_ROOT);
  assert.equal(ws.toAgentPath("analysis/notes.md"), `${AGENT_ROOT}/analysis/notes.md`);

  assert.equal(ws.toWorkspacePath(AGENT_ROOT), "");
  assert.equal(ws.toWorkspacePath(`${AGENT_ROOT}/analysis/notes.md`), "analysis/notes.md");
  assert.equal(ws.toWorkspacePath("/etc/passwd"), null);
  assert.equal(ws.toWorkspacePath(`${AGENT_ROOT}-sibling/x`), null);
  assert.equal(ws.toWorkspacePath(""), null);
});
