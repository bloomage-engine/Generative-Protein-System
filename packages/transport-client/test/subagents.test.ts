import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSubagentTranscript, fetchSubagents } from "../src/subagents.js";
import { withScope } from "../src/scope.js";

test("fetchSubagentTranscript targets the per-child route and parses the body", async () => {
  const transcript = { id: "child-1", parentId: "s1", messages: [] };
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ transcript }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const got = await fetchSubagentTranscript("/api/transport", { projectId: "p1" }, "child-1", "s1");
    assert.deepEqual(got, transcript);
    assert.equal(
      calls[0],
      withScope("/api/transport/subagents/child-1/transcript", { projectId: "p1", threadId: "s1" }),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSubagents throws on a failed poll so the hook can keep its last list", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(() => fetchSubagents("/api/transport", { projectId: "p1", threadId: "s1" }));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSubagentTranscript throws on a 404 (a missing record)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(() => fetchSubagentTranscript("/api/transport", { projectId: "p1" }, "child-x"));
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSubagents carries the Worktree claim only when one is scoped", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ subagents: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const scoped = { projectId: "p1", worktreeId: "exp-a", threadId: "s-exp" };
    await fetchSubagents("/api/transport", scoped);
    assert.equal(calls[0], withScope("/api/transport/subagents", scoped));

    const mainOnly = { projectId: "p1", threadId: "s1" };
    await fetchSubagents("/api/transport", mainOnly);
    assert.equal(calls[1], withScope("/api/transport/subagents", mainOnly));
    assert.doesNotMatch(calls[1]!, /worktreeId=/, "an unscoped poll must not claim a Worktree");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSubagentTranscript carries the Worktree claim only when one is scoped", async () => {
  const transcript = { id: "child-1", parentId: "s-exp", messages: [] };
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ transcript }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const scoped = { projectId: "p1", worktreeId: "exp-a" };
    const got = await fetchSubagentTranscript("/api/transport", scoped, "child-1", "s-exp");
    assert.deepEqual(got, transcript);
    assert.equal(
      calls[0],
      withScope("/api/transport/subagents/child-1/transcript", { ...scoped, threadId: "s-exp" }),
    );

    await fetchSubagentTranscript("/api/transport", { projectId: "p1" }, "child-1", "s1");
    assert.doesNotMatch(calls[1]!, /worktreeId=/, "an unscoped read must not claim a Worktree");
  } finally {
    globalThis.fetch = original;
  }
});
