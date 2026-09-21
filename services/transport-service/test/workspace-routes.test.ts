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
} from "@science-studio/transport";
import { FsWorkspace } from "@science-studio/workspace";
import type { Backend } from "../src/composition.js";
import { createTransportService } from "../src/index.js";

const AGENT_ROOT = "/home/node/.openclaw/workspace";

/** The workspace routes never drive a run; a minimal adapter satisfies the seam. */
function fakeAdapter(): RuntimeAdapter {
  return {
    runtime: "fake",
    init: async () => {},
    run: async function* () {
      /* the workspace routes never call run() */
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
  const root = await mkdtemp(join(tmpdir(), "ss-ws-routes-"));
  await mkdir(join(root, "analysis"));
  await writeFile(join(root, "analysis", "notes.md"), "# notes\n");
  await writeFile(join(root, "big.bin"), "x".repeat(64));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

const wsFor = (root: string) => new FsWorkspace(root, { agentRoot: AGENT_ROOT, maxInlineBytes: 16 });

test("GET /api/workspace/entries lists the workspace root", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      const res = await fetch(`${base}/api/workspace/entries`);
      assert.equal(res.status, 200);
      const listing = (await res.json()) as { path: string; entries: { name: string; kind: string }[] };
      assert.equal(listing.path, "");
      assert.deepEqual(
        listing.entries.map((e) => e.name),
        ["analysis", "big.bin"],
      );
      assert.equal(listing.entries[0]!.kind, "dir");
    });
  } finally {
    await dispose();
  }
});

test("GET /api/workspace/stat returns file metadata", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      const res = await fetch(`${base}/api/workspace/stat?path=analysis/notes.md`);
      assert.equal(res.status, 200);
      const stat = (await res.json()) as { kind: string; mime: string; size: number };
      assert.equal(stat.kind, "file");
      assert.equal(stat.mime, "text/markdown");
      assert.equal(stat.size, "# notes\n".length);
    });
  } finally {
    await dispose();
  }
});

test("GET /api/workspace/file streams inline content with its mime type", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      const res = await fetch(`${base}/api/workspace/file?path=analysis/notes.md`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
      assert.match(res.headers.get("content-disposition") ?? "", /^inline/);
      assert.equal(await res.text(), "# notes\n");
    });
  } finally {
    await dispose();
  }
});

test("GET /api/workspace/file streams a non-ASCII filename without erroring", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-ws-routes-"));
  await mkdir(join(root, "reports"));
  const zh = "软骨素生物合成进展.md";
  await writeFile(join(root, "reports", zh), "# progress\n");
  try {
    await withServer(wsFor(root), async (base) => {
      const res = await fetch(
        `${base}/api/workspace/file?path=${encodeURIComponent(`reports/${zh}`)}`,
      );
      assert.equal(res.status, 200);
      const disposition = res.headers.get("content-disposition") ?? "";
      assert.match(disposition, /^inline/);
      assert.match(disposition, /filename\*=UTF-8''/);
      assert.equal(await res.text(), "# progress\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/workspace/file?download=1 streams an oversized file as an attachment", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      // Inline: over the 16-byte cap -> 413.
      const inline = await fetch(`${base}/api/workspace/file?path=big.bin`);
      assert.equal(inline.status, 413);

      const download = await fetch(`${base}/api/workspace/file?path=big.bin&download=1`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get("content-disposition") ?? "", /^attachment/);
      assert.equal((await download.text()).length, 64);
    });
  } finally {
    await dispose();
  }
});

test("workspace errors map onto 404 / 400", async () => {
  const { root, dispose } = await makeFixture();
  try {
    await withServer(wsFor(root), async (base) => {
      const missing = await fetch(`${base}/api/workspace/stat?path=nope.txt`);
      assert.equal(missing.status, 404);

      const traversal = await fetch(`${base}/api/workspace/stat?path=../outside`);
      assert.equal(traversal.status, 400);

      const absolute = await fetch(`${base}/api/workspace/file?path=/etc/passwd`);
      assert.equal(absolute.status, 400);

      const noPath = await fetch(`${base}/api/workspace/stat`);
      assert.equal(noPath.status, 400);
    });
  } finally {
    await dispose();
  }
});

test("a deployment with no workspace answers 503, not an empty listing", async () => {
  await withServer(new NullWorkspace(), async (base) => {
    const res = await fetch(`${base}/api/workspace/entries`);
    assert.equal(res.status, 503);
  });
});

/** One water molecule — enough to exercise parse → compile → measure. */
const WATER_PDB = [
  "HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O",
  "HETATM    2  H1  HOH A   1       0.957   0.000   0.000  1.00  0.00           H",
  "HETATM    3  H2  HOH A   1      -0.240   0.927   0.000  1.00  0.00           H",
  "END",
  "",
].join("\n");

test("POST /api/workspace/measurements computes a distance, 400 on a bad request", async () => {
  const root = await mkdtemp(join(tmpdir(), "ss-ws-measure-"));
  await writeFile(join(root, "water.pdb"), WATER_PDB);
  try {
    await withServer(wsFor(root), async (base) => {
      const post = (body: unknown) =>
        fetch(`${base}/api/workspace/measurements`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const ok = await post({
        path: "water.pdb",
        kind: "distance",
        selections: [
          "(sel.atom.atoms (= atom.name O))",
          "(sel.atom.atoms (= atom.name H1))",
        ],
      });
      assert.equal(ok.status, 200);
      const result = (await ok.json()) as { kind: string; text: string };
      assert.equal(result.kind, "distance");
      assert.match(result.text, /Distance: 0\.96 Å/);

      const badKind = await post({ path: "water.pdb", kind: "volume", selections: ["(sel.atom.all)"] });
      assert.equal(badKind.status, 400);

      const missingPath = await post({ path: "nope.pdb", kind: "distance", selections: ["(sel.atom.all)", "(sel.atom.all)"] });
      assert.equal(missingPath.status, 404);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
