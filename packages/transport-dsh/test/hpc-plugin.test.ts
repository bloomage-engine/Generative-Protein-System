import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  type HpcHost,
  type HpcPromptSection,
  type HpcToolDefinition,
} from "../src/hpc-plugin.js";

const META = { id: "drought-screen", name: "抗旱基因筛选", createdAt: "2026-09-01T00:00:00.000Z" };

function fakeHost(): {
  ctx: HpcHost;
  tools: () => HpcToolDefinition[];
  sections: () => HpcPromptSection[];
} {
  const tools: HpcToolDefinition[] = [];
  const sections: HpcPromptSection[] = [];
  const ctx: HpcHost = {
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    effect: (body) => {
      body();
    },
  };
  return { ctx, tools: () => tools, sections: () => sections };
}

function tool(host: ReturnType<typeof fakeHost>, name: string): HpcToolDefinition {
  const found = host.tools().find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

interface CalledRequest {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

function stubFetch(
  handler: (req: CalledRequest) => { status: number; json: unknown },
): { calls: CalledRequest[]; restore: () => void } {
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
    return new Response(JSON.stringify(res.json), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("a project config registers the five tools and the prompt section", () => {
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://127.0.0.1:9" });
  assert.deepEqual(host.tools().map((entry) => entry.name).sort(), [
    "hpc_cancel",
    "hpc_files",
    "hpc_jobs",
    "hpc_logs",
    "hpc_submit",
  ]);
  assert.deepEqual(host.sections().map((s) => s.name), ["science-studio-hpc"]);
  assert.equal(host.sections()[0]?.order, 465);
});

test("without Project config the plugin is inert", () => {
  const host = fakeHost();
  apply(host.ctx, {});
  assert.equal(host.tools().length, 0);
  assert.equal(host.sections().length, 0);
});

test("hpc_submit POSTs the script with the Project scope and reports the row", async () => {
  const stub = stubFetch(() => ({
    status: 201,
    json: { job: { id: "cjob-a", name: "md run", state: "pending", remoteJobId: "4242" } },
  }));
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://svc:3001/" });
  try {
    const text = String(await tool(host, "hpc_submit").execute({ name: "md run", script: "#!/bin/bash\necho hi" }, {}));
    assert.match(text, /已提交 Compute Job/);
    assert.match(text, /远端 #4242/);
    assert.equal(stub.calls[0]?.method, "POST");
    assert.ok(stub.calls[0]?.url.startsWith("http://svc:3001/api/hpc/jobs?projectId=drought-screen"));
    assert.equal(stub.calls[0]?.body?.script, "#!/bin/bash\necho hi");
  } finally {
    stub.restore();
  }
});

test("the service's own error text is relayed, not rewritten (docs/adr/0021)", async () => {
  const stub = stubFetch(() => ({ status: 429, json: { error: "endpoint \"cluster-a\" is at its 8-job cap" } }));
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://svc" });
  try {
    const text = String(await tool(host, "hpc_submit").execute({ name: "n", script: "s" }, {}));
    assert.match(text, /8-job cap/);
  } finally {
    stub.restore();
  }
});

test("a unreachable service is a tool result, never a throw", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://svc" });
  try {
    const text = String(await tool(host, "hpc_jobs").execute({}, {}));
    assert.match(text, /无法连接/);
  } finally {
    globalThis.fetch = original;
  }
});

test("hpc_jobs renders the ledger; hpc_logs tails one stream", async () => {
  let mode = "jobs";
  const stub = stubFetch(() =>
    mode === "jobs"
      ? {
          status: 200,
          json: {
            jobs: [
              { id: "cjob-1", name: "a", state: "running", remoteJobId: "11" },
              { id: "cjob-2", name: "b", state: "completed", remoteJobId: "12", exitCode: 0 },
            ],
          },
        }
      : { status: 200, json: { text: "line one\nline two\n" } },
  );
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://svc" });
  try {
    const list = String(await tool(host, "hpc_jobs").execute({}, {}));
    assert.match(list, /\[运行中\] a/);
    assert.match(list, /\[完成\] b.*exit 0/);
    mode = "logs";
    const logs = String(await tool(host, "hpc_logs").execute({ jobId: "cjob-1", stream: "stderr" }, {}));
    assert.match(logs, /line one/);
    assert.ok(stub.calls.some((c) => c.url.includes("/api/hpc/jobs/cjob-1/logs") && c.url.includes("stream=stderr")));
  } finally {
    stub.restore();
  }
});

test("cancel and files validate locally before any network call", async () => {
  const stub = stubFetch(() => ({ status: 200, json: {} }));
  const host = fakeHost();
  apply(host.ctx, { project: META, service: "http://svc" });
  try {
    assert.match(String(await tool(host, "hpc_cancel").execute({ jobId: "../../etc" }, {})), /cjob-/);
    assert.match(String(await tool(host, "hpc_files").execute({ action: "copy", workspacePath: "a", remoteRelPath: "b" }, {})), /action/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
