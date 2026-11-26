/**
 * Conformance suite for `Workspace`.
 *
 * The suite cannot invent a filesystem, so the consumer supplies a fixture: a
 * known directory, a known text file, and a path that does not exist (plus,
 * when the implementation can create one, a symlink that escapes the root).
 * Every assertion below is an interface invariant, not an implementation detail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FileTooLargeError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  type Workspace,
} from "@gps/transport/seams";

export interface WorkspaceFixture {
  /** A directory that exists, workspace-relative ("" for the root). */
  dir: string;
  /** A text file that exists, with known content. */
  textFile: { path: string; content: string; mime?: string };
  /** A path that does NOT exist. */
  missing: string;
  /** A symlink whose target lies outside the root, when the impl can make one. */
  escapingSymlink?: string;
  /** A path the impl MAY write to, when it supports `write` at all. */
  writable?: { path: string; content: string };
}

export interface WorkspaceUnderTest {
  workspace: Workspace;
  fixture: WorkspaceFixture;
  dispose?: () => Promise<void> | void;
}

const MALFORMED = ["/etc/passwd", "../outside", "a/../../outside", "a\\b", "nul\0byte"];

export function testWorkspace(
  name: string,
  setup: () => WorkspaceUnderTest | Promise<WorkspaceUnderTest>,
): void {
  const withWorkspace = async <T>(fn: (underTest: WorkspaceUnderTest) => Promise<T>): Promise<T> => {
    const underTest = await setup();
    try {
      return await fn(underTest);
    } finally {
      await underTest.dispose?.();
    }
  };

  test(`${name}: lists a directory's entries`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      const listing = await workspace.list(fixture.dir);
      assert.equal(listing.path, fixture.dir);
      const expected = fixture.textFile.path.split("/").pop()!;
      assert.ok(
        listing.entries.some((entry) => entry.name === expected),
        `listing of ${JSON.stringify(fixture.dir)} must include ${expected}`,
      );
    });
  });

  test(`${name}: stats an existing file`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      const stat = await workspace.stat(fixture.textFile.path);
      assert.equal(stat.kind, "file");
      assert.equal(stat.path, fixture.textFile.path);
      assert.equal(stat.size, Buffer.byteLength(fixture.textFile.content));
    });
  });

  test(`${name}: opens a file with exactly its content`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      const content = await workspace.open(fixture.textFile.path);
      assert.equal(content.size, Buffer.byteLength(fixture.textFile.content));
      assert.equal(await new Response(content.body).text(), fixture.textFile.content);
      if (fixture.textFile.mime) assert.equal(content.mime, fixture.textFile.mime);
    });
  });

  test(`${name}: rejects malformed and escaping paths`, async () => {
    await withWorkspace(async ({ workspace }) => {
      for (const bad of MALFORMED) {
        await assert.rejects(() => workspace.stat(bad), WorkspacePathError, `stat(${bad})`);
        await assert.rejects(() => workspace.open(bad), WorkspacePathError, `open(${bad})`);
        await assert.rejects(() => workspace.list(bad), WorkspacePathError, `list(${bad})`);
      }
    });
  });

  test(`${name}: reports a missing path as not found`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      await assert.rejects(() => workspace.stat(fixture.missing), WorkspaceNotFoundError);
    });
  });

  test(`${name}: enforces an inline byte cap`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      if (Buffer.byteLength(fixture.textFile.content) <= 1) return; // nothing to cap
      await assert.rejects(
        () => workspace.open(fixture.textFile.path, { maxBytes: 1 }),
        FileTooLargeError,
      );
    });
  });

  test(`${name}: maps paths to and from the agent root`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      const agentPath = workspace.toAgentPath(fixture.textFile.path);
      assert.equal(workspace.toWorkspacePath(agentPath), fixture.textFile.path);

      const agentRoot = workspace.toAgentPath("");
      assert.equal(workspace.toWorkspacePath(`${agentRoot}-sibling/x`), null);
      assert.equal(workspace.toWorkspacePath("/definitely/outside"), null);
    });
  });

  test(`${name}: never reads a symlink that escapes the root`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      if (!fixture.escapingSymlink) return; // impl cannot create symlinks
      await assert.rejects(() => workspace.open(fixture.escapingSymlink!), WorkspacePathError);
    });
  });

  test(`${name}: writes what it can read back`, async () => {
    await withWorkspace(async ({ workspace, fixture }) => {
      if (!fixture.writable) return; // read-only implementation
      const { path, content } = fixture.writable;
      const stat = await workspace.write(path, new TextEncoder().encode(content));
      assert.equal(stat.kind, "file");
      assert.equal(stat.size, Buffer.byteLength(content));
      const written = await workspace.open(path);
      assert.equal(await new Response(written.body).text(), content);
      await assert.rejects(() => workspace.write(path, new Uint8Array(16), { maxBytes: 4 }));
    });
  });
}
