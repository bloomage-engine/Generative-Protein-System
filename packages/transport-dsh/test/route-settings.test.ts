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
