import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeStatus } from "../src/shared/runtime-status.js";

test("reports ready when dsh, provider and model are all present", () => {
  const status = runtimeStatus({
    dshPath: "/opt/bin/dsh",
    config: { provider: "ollama-local", model: "qwen3.8:latest" },
  });
  assert.deepEqual(status, {
    dshPath: "/opt/bin/dsh",
    provider: "ollama-local",
    model: "qwen3.8:latest",
    ready: true,
  });
});

test("is not ready when dsh is missing", () => {
  const status = runtimeStatus({
    dshPath: null,
    config: { provider: "ollama-local", model: "qwen3.8:latest" },
  });
  assert.equal(status.ready, false);
  assert.equal(status.dshPath, null);
});

test("is not ready when the provider is unset", () => {
  const status = runtimeStatus({ dshPath: "/opt/bin/dsh", config: { model: "m" } });
  assert.equal(status.provider, null);
  assert.equal(status.ready, false);
});

test("is not ready when the model is unset", () => {
  const status = runtimeStatus({ dshPath: "/opt/bin/dsh", config: { provider: "p" } });
  assert.equal(status.model, null);
  assert.equal(status.ready, false);
});

test("is not ready for an empty config", () => {
  const status = runtimeStatus({ dshPath: null, config: {} });
  assert.deepEqual(status, { dshPath: null, provider: null, model: null, ready: false });
});
