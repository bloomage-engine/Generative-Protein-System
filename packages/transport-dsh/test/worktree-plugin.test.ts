import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  type WorktreeCommandDefinition,
  type WorktreeHost,
  type WorktreePromptSection,
  type WorktreeToolDefinition,
} from "../src/worktree-plugin.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };
const WT = { id: "exp-a", name: "Experiment A", branch: "exp-a", root: "/w/.worktrees/exp-a" };

function fakeHost() {
  const tools: WorktreeToolDefinition[] = [];
  const sections: WorktreePromptSection[] = [];
  const commands: WorktreeCommandDefinition[] = [];
  const ctx: WorktreeHost = {
    tools: { register: (d) => { tools.push(d); return () => {}; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    commands: { register: (c) => { commands.push(c); return () => {}; } },
    effect: (body) => { body(); },
  };
  return {
    ctx,
    tools: () => tools,
    sections: () => sections,
    commands: () => commands,
  };
}

function tool(host: ReturnType<typeof fakeHost>, name: string): WorktreeToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

interface CalledRequest { url: string; method?: string; body?: Record<string, unknown>; }

function stubFetch(handler: (req: CalledRequest) => { status: number; json: unknown }) {
  const calls: CalledRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const req: CalledRequest = {
      url: String(input),
      ...(init?.method ? { method: init.method } : {}),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    calls.push(req);
    const res = handler(req);
    return new Response(JSON.stringify(res.json), { status: res.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("a project config registers the three tools, the command and the prompt section", () => {
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://127.0.0.1:9" });
  assert.deepEqual(host.tools().map((t) => t.name).sort(), [
    "worktree_create",
    "worktree_list",
    "worktree_remove",
  ]);
  assert.deepEqual(host.commands().map((c) => c.name), ["worktree"]);
  assert.deepEqual(host.sections().map((s) => s.name), ["science-studio-worktree"]);
  assert.equal(host.sections()[0]?.order, 470);
});

test("without Project config the plugin is inert", () => {
  const host = fakeHost();
  apply(host.ctx, {});
  assert.equal(host.tools().length, 0);
  assert.equal(host.sections().length, 0);
  assert.equal(host.commands().length, 0);
});

test("the prompt names the current worktree and its branch", () => {
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  const text = host.sections()[0]?.text ?? "";
  assert.match(text, /Experiment A/);
  assert.match(text, /exp-a/);
  assert.match(text, /无法切换|cannot switch/i);
});

test("worktree_list marks the current worktree", async () => {
  const stub = stubFetch(() => ({
    status: 200,
    json: { worktrees: [
      { id: "main", name: "main", branch: "main" },
      { id: "exp-a", name: "Experiment A", branch: "exp-a" },
    ] },
  }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc:3001/" });
  try {
    const text = String(await tool(host, "worktree_list").execute({}, {}));
    assert.match(text, /Experiment A/);
    assert.match(text, /当前/);
    assert.ok(stub.calls[0]?.url.startsWith("http://svc:3001/api/worktrees?projectId=drought-screen"));
  } finally {
    stub.restore();
  }
});

test("worktree_create POSTs name/branch and reports the new row", async () => {
  const stub = stubFetch(() => ({
    status: 201,
    json: { worktree: { id: "exp-b", name: "Experiment B", branch: "exp-b" } },
  }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const text = String(await tool(host, "worktree_create").execute({ name: "Experiment B" }, {}));
    assert.match(text, /Experiment B/);
    assert.equal(stub.calls[0]?.method, "POST");
    assert.equal(stub.calls[0]?.body?.name, "Experiment B");
  } finally {
    stub.restore();
  }
});

test("worktree_remove validates the id and relays the service error", async () => {
  const stub = stubFetch(() => ({ status: 409, json: { error: "branch is already checked out" } }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const invalid = String(await tool(host, "worktree_remove").execute({ worktree: "bad id!" }, {}));
    assert.match(invalid, /参数无效/);
    const text = String(await tool(host, "worktree_remove").execute({ worktree: "exp-b" }, {}));
    assert.match(text, /already checked out/);
  } finally {
    stub.restore();
  }
});

test("an unreachable service is a tool result, never a throw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const text = String(await tool(host, "worktree_list").execute({}, {}));
    assert.match(text, /无法连接/);
  } finally {
    globalThis.fetch = original;
  }
});

test("/worktree lists worktrees through the same fetch", async () => {
  const stub = stubFetch(() => ({ status: 200, json: { worktrees: [{ id: "main", name: "main", branch: "main" }] } }));
  const host = fakeHost();
  apply(host.ctx, { project: META, worktree: WT, service: "http://svc" });
  try {
    const result = await host.commands()[0]!.handler({ agent: null, rawInput: "/worktree", signal: new AbortController().signal });
    assert.equal(result.kind, "success");
    assert.match(result.text, /main/);
  } finally {
    stub.restore();
  }
});
