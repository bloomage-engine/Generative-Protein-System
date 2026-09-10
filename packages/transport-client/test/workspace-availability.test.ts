import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkspaceRequestError,
  fetchWorkspaceEntries,
  isWorkspaceUnavailable,
} from "../src/workspace.js";

/** Swap the global fetch for the duration of `fn`, restoring it afterwards. */
async function withFetch(handler: () => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a 503 is a status-bearing error classified as 'no workspace configured'", async () => {
  await withFetch(
    async () => json({ error: "workspace is not available (requested )" }, 503),
    async () => {
      await assert.rejects(fetchWorkspaceEntries("/api/workspace", ""), (err: unknown) => {
        assert.ok(err instanceof WorkspaceRequestError, "error carries the HTTP status");
        assert.equal(err.status, 503);
        assert.equal(isWorkspaceUnavailable(err), true);
        return true;
      });
    },
  );
});

test("a 404 keeps its server message and is NOT 'unavailable'", async () => {
  await withFetch(
    async () => json({ error: "not found in workspace: nope" }, 404),
    async () => {
      await assert.rejects(fetchWorkspaceEntries("/api/workspace", "nope"), (err: unknown) => {
        assert.ok(err instanceof WorkspaceRequestError);
        assert.equal(err.status, 404);
        assert.equal(isWorkspaceUnavailable(err), false);
        assert.equal(err.message, "not found in workspace: nope");
        return true;
      });
    },
  );
});

test("a 200 listing resolves normally", async () => {
  await withFetch(
    async () => json({ path: "", entries: [] }, 200),
    async () => {
      assert.deepEqual(await fetchWorkspaceEntries("/api/workspace", ""), {
        path: "",
        entries: [],
      });
    },
  );
});
