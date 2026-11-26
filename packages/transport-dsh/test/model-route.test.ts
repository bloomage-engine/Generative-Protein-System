import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelSelection } from "../src/model-route.js";

async function withHome(settings: string | undefined, body: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "gps-model-route-"));
  try {
    if (settings !== undefined) await writeFile(join(home, "settings.yaml"), settings);
    await body(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("an explicit binding/env pair wins without reading the settings file", async () => {
  await withHome(
    "agent-default-model:\n  provider: settings-provider\n  model: settings-model\n",
    async (home) => {
      assert.deepEqual(
        await resolveModelSelection({ dshHome: home, provider: "explicit", model: "explicit-model" }),
        { provider: "explicit", model: "explicit-model" },
      );
    },
  );
});

test("the harness's agent-default-model is used when the binding has no route", async () => {
  await withHome(
    "agent-default-model:\n  provider: ollama-local\n  model: qwen3.8:latest\n",
    async (home) => {
      assert.deepEqual(await resolveModelSelection({ dshHome: home }), {
        provider: "ollama-local",
        model: "qwen3.8:latest",
      });
    },
  );
});

test("a single configured pi-ai route supplies the provider and its first model", async () => {
  await withHome(
    [
      "llm-pi-ai:",
      "  providers:",
      "    ollama-local:",
      "      api: openai-completions",
      "      baseURL: http://localhost:11434/v1",
      "      models:",
      "        - id: qwen3.8:latest",
      "        - id: llama3.3:70b",
      "",
    ].join("\n"),
    async (home) => {
      assert.deepEqual(await resolveModelSelection({ dshHome: home }), {
        provider: "ollama-local",
        model: "qwen3.8:latest",
      });
    },
  );
});

test("an explicit provider fills the model from its single route", async () => {
  await withHome(
    "llm-pi-ai:\n  providers:\n    ollama-local:\n      models:\n        - qwen3.8:latest\n",
    async (home) => {
      assert.deepEqual(await resolveModelSelection({ dshHome: home, provider: "ollama-local" }), {
        provider: "ollama-local",
        model: "qwen3.8:latest",
      });
    },
  );
});

test("several routes without an explicit default are ambiguous", async () => {
  await withHome(
    [
      "llm-pi-ai:",
      "  providers:",
      "    a:",
      "      models: [{ id: a-1 }]",
      "    b:",
      "      models: [{ id: b-1 }]",
      "",
    ].join("\n"),
    async (home) => {
      assert.equal(await resolveModelSelection({ dshHome: home }), null);
    },
  );
});

test("a missing or malformed settings file yields no automatic selection", async () => {
  await withHome(undefined, async (home) => {
    assert.equal(await resolveModelSelection({ dshHome: home }), null);
  });
  await withHome("agent-default-model: [not: valid\n", async (home) => {
    assert.equal(await resolveModelSelection({ dshHome: home }), null);
  });
});
