import { test } from "node:test";
import assert from "node:assert/strict";
import { dshLocalBinding, parseDshBinding } from "../src/binding.js";

test("dshLocalBinding maps the service-owned endpoint/apiKey env names", () => {
  const binding = dshLocalBinding({
    DSH_PROVIDER: "ollama-local",
    DSH_MODEL: "qwen3.8:latest",
    SS_MODEL_ENDPOINT: "http://10.0.0.1:11434/v1",
    SS_MODEL_API_KEY: "secret",
  });
  const parsed = parseDshBinding(binding);
  assert.equal(parsed.provider, "ollama-local");
  assert.equal(parsed.model, "qwen3.8:latest");
  assert.equal(parsed.endpoint, "http://10.0.0.1:11434/v1");
  assert.equal(parsed.apiKey, "secret");
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyRouteSettings } from "../src/route-settings.js";

const ROUTE_FIXTURE = `# my harness settings
llm-pi-ai:
  providers:
    ollama-local:
      api: openai-completions
      # the LAN endpoint
      baseURL: http://old:11434/v1
      models:
        - id: qwen3.8:latest
      apiKeyEnv: OLLAMA_LOCAL_API_KEY
other:
  keep: me
`;

test("applyRouteSettings updates baseURL and preserves the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-route-settings-"));
  try {
    const file = join(dir, "settings.yaml");
    await writeFile(file, ROUTE_FIXTURE);
    const result = await applyRouteSettings({
      home: dir,
      provider: "ollama-local",
      model: "qwen3.8:latest",
      endpoint: "http://new:11434/v1",
      apiKey: "secret",
    });
    assert.deepEqual(result, { env: { OLLAMA_LOCAL_API_KEY: "secret" } });
    const text = await readFile(file, "utf8");
    assert.match(text, /baseURL: http:\/\/new:11434\/v1/);
    assert.match(text, /# my harness settings/, "unrelated content survives");
    assert.match(text, /# the LAN endpoint/, "the route's comment survives");
    assert.match(text, /other:\n  keep: me/);
    assert.doesNotMatch(text, /^\s*(items|range):/m, "no leaked yaml node internals");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRouteSettings creates a route when the file is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-route-settings-new-"));
  try {
    const result = await applyRouteSettings({
      home: dir,
      provider: "acme",
      model: "m1",
      endpoint: "http://acme/v1",
      apiKey: "k",
    });
    assert.deepEqual(result, { env: { ACME_API_KEY: "k" } });
    const doc = parseYaml(await readFile(join(dir, "settings.yaml"), "utf8")) as {
      "llm-pi-ai": { providers: Record<string, { baseURL: string; apiKeyEnv: string }> };
    };
    assert.equal(doc["llm-pi-ai"].providers.acme!.baseURL, "http://acme/v1");
    assert.equal(doc["llm-pi-ai"].providers.acme!.apiKeyEnv, "ACME_API_KEY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyRouteSettings is a no-op without an endpoint or key", async () => {
  assert.equal(await applyRouteSettings({ home: "/nope", provider: "p" }), null);
});
