import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSettings, subagentWindowFromView, updateSettings } from "../src/settings.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

async function withFetch(
  status: number,
  body: unknown,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const VIEW = {
  model: { provider: "ollama-local", apiKeyConfigured: true },
  plugins: {},
  agent: {},
  runtime: "dsh",
  settingsPath: "/tmp/settings.json",
};

test("fetchSettings GETs the view", async () => {
  await withFetch(200, VIEW, async (calls) => {
    const view = await fetchSettings("/api/settings");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, "/api/settings");
    assert.equal(view.model.provider, "ollama-local");
    assert.equal(view.model.apiKeyConfigured, true);
  });
});

test("updateSettings PUTs the patch as JSON", async () => {
  await withFetch(200, VIEW, async (calls) => {
    await updateSettings("/api/settings", { model: { provider: "p", apiKey: null } });
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[0]!.body, JSON.stringify({ model: { provider: "p", apiKey: null } }));
  });
});

test("a failed request throws with the upstream error text", async () => {
  await withFetch(400, { error: "model.endpoint must be an http(s) URL" }, async () => {
    await assert.rejects(
      () => updateSettings("/api/settings", { model: { endpoint: "ftp://x" } }),
      /model\.endpoint must be an http\(s\) URL/,
    );
  });
});

test("subagentWindowFromView applies the default and bounds", () => {
  assert.equal(subagentWindowFromView({}), 24);
  assert.equal(subagentWindowFromView({ subagents: {} }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 48 } }), 48);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 720 } }), 720);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 721 } }), 720);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: 0 } }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: -1 } }), 24);
  assert.equal(subagentWindowFromView({ subagents: { visibleWindowHours: "x" as never } }), 24);
});
