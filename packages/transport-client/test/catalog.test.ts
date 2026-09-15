import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCommandCatalog } from "../src/catalog.js";

/** Swap the global fetch for the duration of `fn`, restoring it afterwards. */
async function withFetch(
  handler: (url: string) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(String(url))) as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("the catalog request carries the Project, because the adapter it describes is per Project", async () => {
  const seen: string[] = [];
  await withFetch(
    async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ commands: [] }), { status: 200 });
    },
    async () => {
      assert.deepEqual(await fetchCommandCatalog("/api/transport/", "proj a"), []);
      assert.deepEqual(await fetchCommandCatalog("/api/transport", null), []);
    },
  );
  assert.deepEqual(seen, ["/api/transport/commands?projectId=proj%20a", "/api/transport/commands"]);
});

test("a failed catalog fetch is an error the caller degrades from, not a silent empty menu", async () => {
  await withFetch(
    async () => new Response("boom", { status: 500 }),
    async () => {
      await assert.rejects(fetchCommandCatalog("/api/transport", "p1"), /command catalog request failed: 500/);
    },
  );
});
