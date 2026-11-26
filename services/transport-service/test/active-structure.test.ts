import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalEnvironmentProvider,
  LocalPrincipalResolver,
  type RuntimeAdapter,
  type Workspace,
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

const WATER_PDB = [
  "HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O",
  "HETATM    2  H1  HOH A   1       0.957   0.000   0.000  1.00  0.00           H",
  "HETATM    3  H2  HOH A   1      -0.240   0.927   0.000  1.00  0.00           H",
  "END",
  "",
].join("\n");

const O = "(sel.atom.atoms (= atom.name O))";
const H1 = "(sel.atom.atoms (= atom.name H1))";

function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {
      /* the probe drives no adapter work */
    },
    abort: () => {},
  };
}

async function withServer<T>(workspace: Workspace, fn: (base: string) => Promise<T>): Promise<T> {
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
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    app.server.closeAllConnections?.();
    await app.close();
  }
}

async function makeFixture(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ss-active-structure-"));
  await writeFile(join(root, "water.pdb"), WATER_PDB);
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

const wsFor = (root: string) => new FsWorkspace(root, { agentRoot: AGENT_ROOT, maxInlineBytes: 16 });

/** POST one transport send carrying the client's view context (no commands). */
async function reportView(base: string, activeStructure: string | null): Promise<void> {
  const res = await fetch(`${base}/api/transport?projectId=project-default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: [],
      state: { status: "idle", messages: {} },
      view: { activeStructure },
    }),
  });
  assert.equal(res.status, 200);
  await res.text();
}

async function measure(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/workspace/measurements?projectId=project-default`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a structure tool with no path falls back to the file the user is viewing", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      // Before any view report: no explicit file and none open → ask the user.
      const empty = await measure(base, { kind: "distance", selections: [O, H1] });
      assert.equal(empty.status, 400);
      assert.match(((await empty.json()) as { error: string }).error, /ask the user/i);

      // Report the viewed file, then omit path: the service computes on it.
      await reportView(base, "water.pdb");
      const res = await measure(base, { kind: "distance", selections: [O, H1] });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        path: string;
        project: string;
        values: { distance: number };
      };
      assert.equal(body.path, "water.pdb");
      assert.equal(body.project, "project-default");
      assert.ok(Math.abs(body.values.distance - 0.957) < 0.01, `~0.957, got ${body.values.distance}`);

      // An explicit path still wins over the viewed file.
      const explicit = await measure(base, {
        kind: "distance",
        selections: [O, H1],
        path: "water.pdb",
      });
      assert.equal(explicit.status, 200);
    });
  } finally {
    await dispose();
  }
});

test("a cleared view report restores the ask-the-user answer", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      await reportView(base, "water.pdb");
      await reportView(base, null);
      const res = await measure(base, { kind: "distance", selections: [O, H1] });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /ask the user/i);
    });
  } finally {
    await dispose();
  }
});

test("GET /api/transport/active-structure reports the file being viewed", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      const none = await fetch(`${base}/api/transport/active-structure`);
      assert.equal(none.status, 200);
      assert.deepEqual(await none.json(), { path: null });

      await reportView(base, "water.pdb");
      assert.deepEqual(await (await fetch(`${base}/api/transport/active-structure`)).json(), {
        path: "water.pdb",
      });

      await reportView(base, null);
      assert.deepEqual(await (await fetch(`${base}/api/transport/active-structure`)).json(), {
        path: null,
      });
    });
  } finally {
    await dispose();
  }
});
