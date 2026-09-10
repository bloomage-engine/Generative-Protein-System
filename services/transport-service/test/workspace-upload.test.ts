import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type QuotaPolicy,
  type RuntimeAdapter,
  type Workspace,
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {
      /* uploads never drive a run */
    },
    abort: () => {},
  };
}

async function withServer(
  workspace: Workspace,
  fn: (base: string) => Promise<void>,
  opts: { maxUploadBytes?: number; quota?: QuotaPolicy } = {},
): Promise<void> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({ adapter: fakeAdapter(), workspace }),
    cors: { origin: true },
    ...(opts.maxUploadBytes !== undefined
      ? { workspaceLimits: { maxUploadBytes: opts.maxUploadBytes } }
      : {}),
    ...(opts.quota ? { quota: opts.quota } : {}),
  };
  const app = await createTransportService({ backend });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

function upload(base: string, path: string, body: Uint8Array): Promise<Response> {
  return fetch(`${base}/api/workspace/upload?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
}

async function makeRoot(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ss-upload-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("POST /api/workspace/upload writes the file and returns a workspace attachment", async () => {
  const { root, dispose } = await makeRoot();
  try {
    await withServer(new FsWorkspace(root, { agentRoot: AGENT_ROOT }), async (base) => {
      const res = await upload(base, "uploads/notes.md", new TextEncoder().encode("# hi\n"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { attachment: Record<string, unknown> };
      assert.deepEqual(body.attachment, {
        kind: "workspace",
        path: "uploads/notes.md",
        name: "notes.md",
        mime: "text/markdown",
        size: 5,
        entryKind: "file",
      });

      // The file is now readable through the read-only routes.
      const read = await fetch(`${base}/api/workspace/file?path=uploads/notes.md`);
      assert.equal(read.status, 200);
      assert.equal(await read.text(), "# hi\n");
    });
  } finally {
    await dispose();
  }
});

test("an over-cap upload answers 413 and writes nothing", async () => {
  const { root, dispose } = await makeRoot();
  try {
    await withServer(
      new FsWorkspace(root, { agentRoot: AGENT_ROOT }),
      async (base) => {
        const res = await upload(base, "big.bin", new Uint8Array(64));
        assert.equal(res.status, 413);
        const listing = await fetch(`${base}/api/workspace/entries`);
        const body = (await listing.json()) as { entries: { name: string }[] };
        assert.deepEqual(body.entries, [], "nothing may be written");
      },
      { maxUploadBytes: 8 },
    );
  } finally {
    await dispose();
  }
});

test("upload refuses an escaping path (400) and needs a path (400)", async () => {
  const { root, dispose } = await makeRoot();
  try {
    await withServer(new FsWorkspace(root, { agentRoot: AGENT_ROOT }), async (base) => {
      const escape = await upload(base, "../evil.txt", new Uint8Array([1]));
      assert.equal(escape.status, 400);

      const noPath = await fetch(`${base}/api/workspace/upload`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1]),
      });
      assert.equal(noPath.status, 400);
    });
  } finally {
    await dispose();
  }
});

test("a deployment with no workspace answers 503", async () => {
  await withServer(new NullWorkspace(), async (base) => {
    const res = await upload(base, "notes.md", new TextEncoder().encode("hi"));
    assert.equal(res.status, 503);
  });
});

test("a rejected quota answers 507 before anything is written", async () => {
  const { root, dispose } = await makeRoot();
  try {
    const quota: QuotaPolicy = {
      check: async () => {
        throw new Error("tenant quota exceeded");
      },
    };
    await withServer(
      new FsWorkspace(root, { agentRoot: AGENT_ROOT }),
      async (base) => {
        const res = await upload(base, "notes.md", new TextEncoder().encode("hi"));
        assert.equal(res.status, 507);
        const listing = await fetch(`${base}/api/workspace/entries`);
        const body = (await listing.json()) as { entries: { name: string }[] };
        assert.deepEqual(body.entries, []);
      },
      { quota },
    );
  } finally {
    await dispose();
  }
});
