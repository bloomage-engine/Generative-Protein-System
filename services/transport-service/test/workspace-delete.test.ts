import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  NullWorkspace,
  type RuntimeAdapter,
  type Workspace,
} from "@gps/transport";
import { FsWorkspace } from "@gps/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {
      /* deletes never drive a run */
    },
    abort: () => {},
  };
}

async function withServer(
  workspace: Workspace,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const backend: Backend = {
    principal: new LocalPrincipalResolver(),
    environments: new LocalEnvironmentProvider({
      environmentFor: async () => ({ adapter: fakeAdapter(), workspace }),
    }),
    cors: { origin: true },
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

function del(base: string, path: string): Promise<Response> {
  return fetch(`${base}/api/workspace/delete?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
}

/** A root with `analysis/notes.md` and `data.csv`. */
async function makeFixture(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gps-delete-"));
  await mkdir(join(root, "analysis"));
  await writeFile(join(root, "analysis", "notes.md"), "# notes\n");
  await writeFile(join(root, "data.csv"), "a,b\n");
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("POST /api/workspace/delete removes a file", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(new FsWorkspace(root, { agentRoot: AGENT_ROOT }), async (base) => {
      const res = await del(base, "data.csv");
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()) as unknown, { ok: true });

      // The file is gone: the read-only routes no longer find it.
      assert.equal((await fetch(`${base}/api/workspace/file?path=data.csv`)).status, 404);
      const body = (await (await fetch(`${base}/api/workspace/entries`)).json()) as {
        entries: { name: string }[];
      };
      assert.deepEqual(body.entries.map((e) => e.name), ["analysis"]);
    });
  } finally {
    await dispose();
  }
});

test("POST /api/workspace/delete removes a whole directory tree", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(new FsWorkspace(root, { agentRoot: AGENT_ROOT }), async (base) => {
      assert.equal((await del(base, "analysis")).status, 200);
      assert.equal((await fetch(`${base}/api/workspace/file?path=analysis/notes.md`)).status, 404);
      const body = (await (await fetch(`${base}/api/workspace/entries`)).json()) as {
        entries: { name: string }[];
      };
      assert.deepEqual(body.entries.map((e) => e.name), ["data.csv"]);
    });
  } finally {
    await dispose();
  }
});

test("POST /api/workspace/delete refuses escaping paths and a missing path", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(new FsWorkspace(root, { agentRoot: AGENT_ROOT }), async (base) => {
      assert.equal((await del(base, "../evil")).status, 400);
      assert.equal(
        (await fetch(`${base}/api/workspace/delete`, { method: "POST" })).status,
        400,
      );
    });
  } finally {
    await dispose();
  }
});

test("a deployment with no workspace answers 503", async () => {
  await withServer(new NullWorkspace(), async (base) => {
    assert.equal((await del(base, "notes.md")).status, 503);
  });
});
