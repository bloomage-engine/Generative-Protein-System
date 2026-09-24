import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorktree,
  DEFAULT_WORKTREE_ID,
  deleteWorktree,
  fetchWorktrees,
} from "../src/worktrees.js";
import { createSession, fetchProjectSessions } from "../src/projects.js";

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; json: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const res = handler(String(input), init);
    return new Response(JSON.stringify(res.json), { status: res.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("fetchWorktrees scopes by projectId", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { worktrees: [{ id: "main", projectId: "p1", name: "main", branch: "main", createdAt: "x" }] } }));
  try {
    const list = await fetchWorktrees("/api/worktrees", "p1");
    assert.equal(list[0]?.id, DEFAULT_WORKTREE_ID);
    assert.ok(stub.calls[0]?.url.includes("/api/worktrees?projectId=p1"));
  } finally {
    stub.restore();
  }
});

test("createWorktree POSTs the body and returns the row", async () => {
  const stub = stubFetch(() => ({ status: 201, json: { worktree: { id: "exp-a", projectId: "p1", name: "Experiment A", branch: "exp-a", createdAt: "x" } } }));
  try {
    const wt = await createWorktree("/api/worktrees", "p1", { name: "Experiment A" });
    assert.equal(wt.id, "exp-a");
    assert.equal(stub.calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init?.body)), { name: "Experiment A" });
  } finally {
    stub.restore();
  }
});

test("deleteWorktree POSTs the delete action", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { ok: true } }));
  try {
    await deleteWorktree("/api/worktrees", "p1", "exp-a");
    assert.ok(stub.calls[0]?.url.includes("/api/worktrees/exp-a/delete?projectId=p1"));
  } finally {
    stub.restore();
  }
});

test("fetchProjectSessions scopes the listing to a worktree", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { sessions: [] } }));
  try {
    await fetchProjectSessions("/api/projects", { projectId: "p1", worktreeId: "exp-a" });
    assert.ok(stub.calls[0]?.url.includes("/api/projects/p1/sessions?worktreeId=exp-a"));

    await fetchProjectSessions(
      "/api/projects",
      { projectId: "p1", worktreeId: "exp-a" },
      { includeArchived: true },
    );
    assert.ok(
      stub.calls[1]?.url.includes("/api/projects/p1/sessions?includeArchived=1&worktreeId=exp-a"),
    );
  } finally {
    stub.restore();
  }
});

test("createSession POSTs the worktree the Session belongs to", async () => {
  const stub = stubFetch(() => ({ status: 201, json: { session: { id: "s1" } } }));
  try {
    const session = await createSession("/api/projects", { projectId: "p1", worktreeId: "exp-a" });
    assert.equal(session.id, "s1");
    assert.equal(stub.calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init?.body)), { worktreeId: "exp-a" });
  } finally {
    stub.restore();
  }
});
